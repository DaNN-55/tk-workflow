import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  runCodexWorker,
  type ClaimedWorkerTask,
} from "./codexRunner.js";
import type { WorkerTaskPackage } from "./contracts.js";
import type { ArtifactManifest } from "./contracts.js";
import { verifyArtifactIndex, verifyMediaLibrary } from "./mediaLibrary.js";
import { nonNegativeIntegerEnvironment, requiredEnvironment } from "./runtimeEnvironment.js";

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
const actualCostCents = nonNegativeIntegerEnvironment("CODEX_WORKER_ACTUAL_COST_CENTS");
const mediaLibraryMountPath = requiredEnvironment("MEDIA_LIBRARY_MOUNT_PATH");
const mediaLibraryMinimumFreeBytes = nonNegativeIntegerEnvironment("MEDIA_LIBRARY_MIN_FREE_BYTES");
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const workerResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "taskId", "status", "artifacts", "validation", "actualCostCents", "blockers", "retry", "nextStep"],
  properties: {
    version: { type: "string", const: "worker-result/v1" },
    taskId: { type: "string" },
    status: { type: "string", enum: ["completed", "blocked", "failed"] },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artifactType", "relativePath", "sha256", "fileSize"],
        properties: {
          artifactType: { type: "string" },
          relativePath: { type: "string" },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          fileSize: { type: "integer", minimum: 0 },
        },
      },
    },
    validation: {
      type: "object",
      additionalProperties: false,
      required: ["passed", "checks"],
      properties: {
        passed: { type: "boolean" },
        checks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "passed", "detail"],
            properties: { name: { type: "string" }, passed: { type: "boolean" }, detail: { type: "string" } },
          },
        },
      },
    },
    actualCostCents: { type: "integer", minimum: 0 },
    blockers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "detail"],
        properties: { code: { type: "string" }, detail: { type: "string" } },
      },
    },
    retry: {
      type: "object",
      additionalProperties: false,
      required: ["shouldRetry", "reason"],
      properties: { shouldRetry: { type: "boolean" }, reason: { type: "string" } },
    },
    nextStep: { type: "string" },
  },
} as const;

const result = await runCodexWorker({
  claimNextTask: claimNextTask,
  reportResult,
  verifyAssetRoot,
  verifyArtifacts,
  execute: executeCodex,
  actualCostCents,
});

process.stdout.write(`${JSON.stringify(result)}\n`);

async function claimNextTask(): Promise<ClaimedWorkerTask | null> {
  const { data, error } = await supabase.rpc("claim_next_worker_task");
  if (error) throw new Error(`Unable to claim a worker task: ${error.message}`);
  const row = data?.[0];
  if (!row) return null;
  if (row.provider !== "codex") throw new Error(`Unsupported worker provider: ${row.provider}`);

  return {
    taskId: row.task_id,
    taskType: row.task_type,
    attempt: row.attempt,
    budgetLimitCents: row.budget_limit_cents,
    maxAttempts: row.max_attempts,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    episodeId: row.episode_id,
    accountId: row.account_id,
    blueprintVersionId: row.blueprint_version_id,
    title: row.title,
    allowedAssetRoot: row.allowed_asset_root,
    inputSnapshot: row.input_snapshot,
  };
}

async function reportResult(taskId: string, attempt: number, workerResult: unknown): Promise<void> {
  const { error } = await supabase.rpc("report_worker_result", {
    p_task_id: taskId,
    p_attempt: attempt,
    p_result: workerResult,
  });
  if (error) throw new Error(`Unable to report the worker result: ${error.message}`);
}

async function verifyAssetRoot(allowedAssetRoot: string): Promise<void> {
  await verifyMediaLibrary({
    assetRoot: allowedAssetRoot,
    mountPath: mediaLibraryMountPath,
    minimumFreeBytes: mediaLibraryMinimumFreeBytes,
  });
}

async function verifyArtifacts(taskPackage: WorkerTaskPackage, artifacts: ArtifactManifest[]): Promise<void> {
  await verifyArtifactIndex({ assetRoot: taskPackage.assets.allowedRoot, episodeId: taskPackage.episode.id, artifacts });
}

async function executeCodex(taskPackage: WorkerTaskPackage): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tk-workflow-codex-"));
  const schemaPath = join(directory, "worker-result.schema.json");
  const resultPath = join(directory, "result.json");
  try {
    await writeFile(schemaPath, JSON.stringify(workerResultJsonSchema));
    await runCommand("codex", [
      "--ask-for-approval", "never",
      "exec",
      "--ephemeral",
      "--sandbox", "workspace-write",
      "--skip-git-repo-check",
      "--cd", taskPackage.assets.allowedRoot,
      "--model", taskPackage.model,
      "--output-schema", schemaPath,
      "--output-last-message", resultPath,
      buildCodexPrompt(taskPackage),
    ]);
    return await readFile(resultPath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function buildCodexPrompt(taskPackage: WorkerTaskPackage): string {
  return [
    "You are the Codex Content Worker for a controlled production platform.",
    "Work only inside assets.allowedRoot. Do not inspect, modify, or transmit files outside that directory.",
    "Do not approve, publish, change any blueprint, call platform APIs, or change an Episode stage.",
    "If any required input, tool, permission, or rule is missing, return status blocked with explicit blockers; do not silently substitute a provider.",
    `Create only the required artifacts inside episodes/${taskPackage.episode.id}/ and return a JSON result that matches the provided schema. Use paths relative to assets.allowedRoot and SHA-256 hashes in lowercase hexadecimal.`,
    "The retry reason must always be non-empty. For a completed result, set retry.shouldRetry to false and retry.reason to Completed successfully.",
    "Task package:",
    JSON.stringify(taskPackage),
  ].join("\n\n");
}

function runCommand(command: string, argumentsList: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Codex exited with status ${code ?? "unknown"}.`));
    });
  });
}
