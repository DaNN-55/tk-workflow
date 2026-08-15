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
import { workerResultJsonSchema } from "./workerResultSchema.js";
import { executeControlledMediaTask } from "./controlledMediaExecutor.js";
import { readTaskIdArgument } from "./taskClaimArguments.js";

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
const actualCostCents = nonNegativeIntegerEnvironment("CODEX_WORKER_ACTUAL_COST_CENTS");
const mediaLibraryMountPath = requiredEnvironment("MEDIA_LIBRARY_MOUNT_PATH");
const mediaLibraryMinimumFreeBytes = nonNegativeIntegerEnvironment("MEDIA_LIBRARY_MIN_FREE_BYTES");
const requestedTaskId = readTaskIdArgument(process.argv.slice(2));
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const result = await runCodexWorker({
  claimNextTask: claimNextTask,
  reportResult,
  verifyAssetRoot,
  verifyArtifacts,
  execute: executeTask,
  actualCostCents,
});

process.stdout.write(`${JSON.stringify(result)}\n`);

async function claimNextTask(): Promise<ClaimedWorkerTask | null> {
  const { data, error } = await supabase.rpc("claim_next_worker_task", requestedTaskId ? { p_task_id: requestedTaskId } : {});
  if (error) throw new Error(`Unable to claim a worker task: ${error.message}`);
  const row = data?.[0];
  if (!row) return null;
  if (row.provider !== "codex" && row.provider !== "google_tts" && row.provider !== "pexels" && row.provider !== "ffmpeg" && row.provider !== "freesound") throw new Error(`Unsupported worker provider: ${row.provider}`);

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

async function executeTask(taskPackage: WorkerTaskPackage): Promise<string> {
  if (taskPackage.provider === "codex") return executeCodex(taskPackage);
  return executeControlledMediaTask({
    taskPackage,
    fetcher: fetch,
    pexelsApiKey: process.env.PEXELS_API_KEY,
    googleTtsApiKey: process.env.GOOGLE_TTS_API_KEY,
    freesoundApiKey: process.env.FREESOUND_API_KEY,
    validateMp4: validateMp4Artifact,
    probeMp3: probeMp3Artifact,
    extractMp3: extractMp3Artifact,
  });
}

async function extractMp3Artifact(sourcePath: string, minimumDurationSeconds: number): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "tk-workflow-audio-"));
  const outputPath = join(directory, "derived.mp3");
  try {
    await runCommand("ffmpeg", ["-nostdin", "-v", "error", "-i", sourcePath, "-vn", "-codec:a", "libmp3lame", "-q:a", "2", outputPath]);
    const { stdout } = await runCommandWithOutput("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputPath]);
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration < minimumDurationSeconds) throw new Error(`派生音频不可播放或时长不足：${duration || "未知"} 秒。`);
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function probeMp3Artifact(path: string): Promise<number> {
  const { stdout } = await runCommandWithOutput("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("音频不可播放或缺少有效时长。");
  return duration;
}

async function validateMp4Artifact(path: string, minimumDurationSeconds: number): Promise<void> {
  const { stdout } = await runCommandWithOutput("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration < minimumDurationSeconds) {
    throw new Error(`Pexels 视频不可播放或时长不足：${duration || "未知"} 秒。`);
  }
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
    await writeFile(schemaPath, JSON.stringify(workerResultJsonSchema(taskPackage.capability)));
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
    "For a completed storyboard_planning task, write the primary artifact as valid JSON and also return the identical object in result.storyboard. It must have version storyboard/v1, a non-empty shots array, and an audioCues array (empty when no BGM/SFX is needed). Every shot needs id, scriptSegment, durationSeconds, shotType (a_roll or b_roll), productionMethod, inputBasis (objects containing each frozen input's relativePath and sha256), and targetSpec. Each optional audio cue needs id, kind (bgm or sfx), description, searchQuery, startSeconds, and durationSeconds. description is the Owner-facing display text; searchQuery is a concise English Freesound search phrase of at most 100 characters. Each shot must include the frozen main script and at least one approved visual input. For a blocked or failed storyboard_planning task, set result.storyboard to null. Do not generate or queue A-roll, B-roll, or audio media; this task is only the reviewable storyboard. When reviewAnnotations are present, revise the matching shot IDs to address their reasons.",
    "For a_roll_generation, create only the frozen shot in aRoll with its declared aRoll.adapter. Do not replace the adapter, add other shots, scan for newer inputs, or advance an Episode stage. Use only aRoll.shot.inputBasis and produce the frozen video output contract; if the declared adapter cannot produce that output, return blocked with an explicit blocker.",
    "Do not approve, publish, change any blueprint, call platform APIs, or change an Episode stage.",
    "If any required input, tool, permission, or rule is missing, return status blocked with explicit blockers; do not silently substitute a provider.",
    `Create the required artifact at output.relativePath inside episodes/${taskPackage.episode.id}/ and return a JSON result that matches the provided schema. Use paths relative to assets.allowedRoot and SHA-256 hashes in lowercase hexadecimal.`,
    "The retry reason must always be non-empty. For a completed result, set retry.shouldRetry to false and retry.reason to Completed successfully.",
    "Task package:",
    JSON.stringify(taskPackage),
  ].join("\n\n");
}

function runCommand(command: string, argumentsList: string[]): Promise<void> {
  return runCommandWithOutput(command, argumentsList).then(() => undefined);
}

function runCommandWithOutput(command: string, argumentsList: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr.trim() || `Codex exited with status ${code ?? "unknown"}.`));
    });
  });
}
