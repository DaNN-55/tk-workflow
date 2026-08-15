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
import type { StoryboardManifest } from "./contracts.js";
import { verifyArtifactIndex, verifyMediaLibrary } from "./mediaLibrary.js";
import { nonNegativeIntegerEnvironment, requiredEnvironment } from "./runtimeEnvironment.js";
import { verifyReportedStoryboardArtifact } from "./storyboardArtifact.js";

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
    storyboard: {
      type: "object",
      additionalProperties: false,
      required: ["version", "shots"],
      properties: {
        version: { type: "string", const: "storyboard/v1" },
        shots: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "scriptSegment", "durationSeconds", "shotType", "productionMethod", "inputBasis", "targetSpec"],
            properties: {
              id: { type: "string", minLength: 1 },
              scriptSegment: { type: "string", minLength: 1 },
              durationSeconds: { type: "number", exclusiveMinimum: 0 },
              shotType: { type: "string", enum: ["a_roll", "b_roll"] },
              productionMethod: { type: "string", minLength: 1 },
              inputBasis: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["relativePath", "sha256"],
                  properties: { relativePath: { type: "string" }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
                },
              },
              targetSpec: { type: "string", minLength: 1 },
            },
          },
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
      properties: { shouldRetry: { type: "boolean", const: false }, reason: { type: "string" } },
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

async function verifyArtifacts(taskPackage: WorkerTaskPackage, artifacts: ArtifactManifest[], storyboard?: StoryboardManifest): Promise<void> {
  await verifyArtifactIndex({ assetRoot: taskPackage.assets.allowedRoot, episodeId: taskPackage.episode.id, artifacts });
  if (storyboard) await verifyReportedStoryboardArtifact({
    assetRoot: taskPackage.assets.allowedRoot,
    frozenInputs: [...taskPackage.assets.inputs],
    relativePath: taskPackage.output.relativePath,
    storyboard,
  });
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
    "Use only the tools listed in allowedTools. If the task cannot be completed with them, return blocked instead of substituting another tool.",
    "allowedTools is a capability policy, not a list of Codex tool names. When it includes read and write, use your normal workspace filesystem tools only to read and write within assets.allowedRoot.",
    "When task package includes seriesBaseline, it is an approved, frozen reusable base. For visual planning, do not regenerate covered characters, voices, or visual references; create only additions or explicit deviations. Produce every output.requiredArtifactTypes, with the primary artifact at output.relativePath. Visual reference groups must be organized by character, location, and key prop; static visuals must be previewable images (SVG is allowed).",
    "For storyboard_planning, write the primary artifact as valid JSON and also return the identical object in result.storyboard. It must have version storyboard/v1 and a non-empty shots array. Every shot needs id, scriptSegment, durationSeconds, shotType (a_roll or b_roll), productionMethod, inputBasis (objects containing each frozen input's relativePath and sha256), and targetSpec. Each shot must include the frozen main script and at least one approved visual input. Do not generate or queue A-roll, B-roll, or audio media; this task is only the reviewable storyboard. When reviewAnnotations are present, revise the matching shot IDs to address their reasons.",
    "Do not approve, publish, change any blueprint, call platform APIs, or change an Episode stage.",
    "If any required input, tool, permission, or rule is missing, return status blocked with explicit blockers; do not silently substitute a provider.",
    `Create the required artifact at output.relativePath inside episodes/${taskPackage.episode.id}/ and return a JSON result that matches the provided schema. Use paths relative to assets.allowedRoot and SHA-256 hashes in lowercase hexadecimal.`,
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
