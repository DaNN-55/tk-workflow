import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  runCodexWorker,
  parseCodexOutput,
  type ClaimedWorkerTask,
  type WorkerProgress,
} from "./codexRunner.js";
import type { ArtifactManifest, VisualAssetRequest, WorkerPreflightResult, WorkerTaskPackage } from "./contracts.js";
import type { StoryboardManifest } from "./contracts.js";
import { verifyArtifactIndex, verifyMediaLibrary } from "./mediaLibrary.js";
import { nonNegativeIntegerEnvironment, requiredEnvironment } from "./runtimeEnvironment.js";
import { addFrozenStoryboardBasis, refreshArtifactManifest, verifyReportedStoryboardArtifact } from "./storyboardArtifact.js";
import { applyStoryboardStructureRevision } from "./storyboardRevision.js";
import { workerResultJsonSchema } from "./workerResultSchema.js";
import { executeControlledMediaTask, writeSafeAssetFile } from "./controlledMediaExecutor.js";
import { generateCloudflareWorkersAiImage, generateOpenAiImage } from "./mediaProviders.js";
import { createHash } from "node:crypto";
import { executeOpenChatCutRender } from "./openchatcutRenderer.js";
import { durationToleranceSeconds, videoDurationMeetsMinimum } from "./durationDecision.js";
import { readTaskIdArgument } from "./taskClaimArguments.js";
import { createRuntimePreflight, credentialEnvironmentForReference, localAdapterReadinessFromCommands, runtimeCapabilityFromTask, runtimeCommandArguments, runtimeCommandInvocation } from "./runtimePreflight.js";
import { probeCodexModel, probeProviderConnection } from "./runtimeProbes.js";
import { runLocalWhisperXAlignment } from "./whisperxAlignment.js";

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
const actualCostCents = nonNegativeIntegerEnvironment("CODEX_WORKER_ACTUAL_COST_CENTS");
const mediaLibraryMountPath = requiredEnvironment("MEDIA_LIBRARY_MOUNT_PATH");
const mediaLibraryMinimumFreeBytes = nonNegativeIntegerEnvironment("MEDIA_LIBRARY_MIN_FREE_BYTES");
const workerCapacity = Number(process.env.CODEX_WORKER_CAPACITY ?? "2");
if (!Number.isSafeInteger(workerCapacity) || workerCapacity <= 0) throw new Error("CODEX_WORKER_CAPACITY must be a positive integer.");
const codexExecutionTimeoutMs = Number(process.env.CODEX_WORKER_EXECUTION_TIMEOUT_MS ?? "300000");
if (!Number.isSafeInteger(codexExecutionTimeoutMs) || codexExecutionTimeoutMs <= 0) throw new Error("CODEX_WORKER_EXECUTION_TIMEOUT_MS must be a positive integer.");
const requestedTaskId = readTaskIdArgument(process.argv.slice(2));
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const workerLeaseHeartbeatMs = 5 * 60 * 1000;
let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;

const result = await runCodexWorker({
  claimNextTask: claimNextTask,
  reportResult,
  verifyAssetRoot,
  verifyArtifacts,
  preflight: preflightTask,
  reportProgress,
  execute: executeTask,
  actualCostCents,
});

process.stdout.write(`${JSON.stringify(result)}\n`);

async function claimNextTask(): Promise<ClaimedWorkerTask | null> {
  const { data, error } = await supabase.rpc("claim_next_worker_task", { p_worker_capacity: workerCapacity, ...(requestedTaskId ? { p_task_id: requestedTaskId } : {}) });
  if (error) throw new Error(`Unable to claim a worker task: ${error.message}`);
  const row = data?.[0];
  if (!row) return null;
  if (row.provider !== "codex" && row.provider !== "google_tts" && row.provider !== "volcengine_tts" && row.provider !== "pexels" && row.provider !== "ffmpeg" && row.provider !== "freesound" && row.provider !== "openchatcut" && row.provider !== "openai" && row.provider !== "cloudflare" && row.provider !== "whisperx") throw new Error(`Unsupported worker provider: ${row.provider}`);
  startLeaseHeartbeat(row.task_id, row.attempt);

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
  if (taskPackage.storyboardRevision) return executeStoryboardRevision(taskPackage);
  if (taskPackage.provider === "codex") {
    const output = await executeCodex(taskPackage);
    const completedOutput = taskPackage.visualAssetPreparation?.imageGeneration ? await generateVisualAssets(taskPackage, output) : output;
    return taskPackage.capability === "storyboard_planning" ? useWrittenStoryboard(taskPackage, completedOutput) : completedOutput;
  }
  if (taskPackage.provider === "openchatcut") {
    const input = { taskPackage, run: runCommand, validateMp4: validateMp4Artifact, inspectMp4: inspectMp4Artifact };
    return executeOpenChatCutRender(input);
  }
  if (taskPackage.provider === "whisperx") return executeWhisperXTask(taskPackage);
  const apiKey = await resolveTaskSecret(taskPackage);
  return executeControlledMediaTask({
    taskPackage,
    fetcher: fetch,
    pexelsApiKey: taskPackage.provider === "pexels" ? apiKey : undefined,
    googleTtsApiKey: taskPackage.provider === "google_tts" ? apiKey : undefined,
    volcengineTtsApiKey: taskPackage.provider === "volcengine_tts" ? apiKey : undefined,
    freesoundApiKey: taskPackage.provider === "freesound" ? apiKey : undefined,
    openaiApiKey: taskPackage.provider === "openai" ? apiKey : undefined,
    cloudflareWorkersAiCredentials: taskPackage.provider === "cloudflare" ? apiKey : undefined,
    validateMp4: validateMp4Artifact,
    probeMp3: probeMp3Artifact,
    extractMp3: extractMp3Artifact,
    trimMp3: trimMp3Artifact,
    trimMp4: trimMp4Artifact,
    trimMp4Segments: trimMp4SegmentsArtifact,
    whisperXCacheDirectory: process.env.WHISPERX_MODEL_CACHE?.trim() || join(mediaLibraryMountPath, ".cache", "whisperx"),
  });
}

async function executeWhisperXTask(taskPackage: WorkerTaskPackage): Promise<string> {
  const alignment = taskPackage.acousticAlignment;
  if (taskPackage.capability !== "acoustic_alignment" || !alignment?.audioRelativePath || !alignment.audioSha256 || !alignment.inputVersion) throw new Error("本地 WhisperX 任务缺少冻结对齐输入。");
  const result = await runLocalWhisperXAlignment({
    audioPath: join(taskPackage.assets.allowedRoot, alignment.audioRelativePath),
    audioSha256: alignment.audioSha256,
    cacheDirectory: process.env.WHISPERX_MODEL_CACHE?.trim() || join(mediaLibraryMountPath, ".cache", "whisperx"),
    confirmedText: alignment.confirmedText,
    model: taskPackage.model,
    speakingRate: alignment.speakingRate ?? 1,
    voice: alignment.voice ?? "",
  });
  const content = new TextEncoder().encode(`${JSON.stringify(result, null, 2)}\n`);
  await writeSafeAssetFile(taskPackage.assets.allowedRoot, taskPackage.output.relativePath, content);
  const artifact = { artifactType: taskPackage.output.requiredArtifactTypes[0] ?? "acoustic_alignment_evidence", relativePath: taskPackage.output.relativePath, sha256: createHash("sha256").update(content).digest("hex"), fileSize: content.byteLength };
  return JSON.stringify({ version: "worker-result/v1", taskId: taskPackage.task.id, status: "completed", artifacts: [artifact], acousticAlignment: result, validation: { passed: true, checks: [{ name: "whisperx_alignment_output", passed: true, detail: result.status === "completed" ? "本地 WhisperX 时序与 Owner 正文已完整匹配。" : "本地 WhisperX 已返回候选时序和人工检查区间。" }] }, actualCostCents: 0, blockers: [], retry: { shouldRetry: false, reason: "Local alignment completed." }, nextStep: result.status === "completed" ? "Review the current shot timing." : "Owner must review unmatched or low-confidence intervals." });
}

async function executeStoryboardRevision(taskPackage: WorkerTaskPackage): Promise<string> {
  const revision = taskPackage.storyboardRevision;
  if (!revision) throw new Error("缺少分镜结构修订。");
  const storyboard = applyStoryboardStructureRevision(revision.storyboard, revision.operation);
  const content = `${JSON.stringify(storyboard, null, 2)}\n`;
  await writeFile(join(taskPackage.assets.allowedRoot, taskPackage.output.relativePath), content);
  const artifact = { artifactType: taskPackage.output.requiredArtifactTypes[0] ?? "storyboard", relativePath: taskPackage.output.relativePath, sha256: createHash("sha256").update(content).digest("hex"), fileSize: Buffer.byteLength(content) };
  return JSON.stringify({ version: "worker-result/v1", taskId: taskPackage.task.id, status: "completed", artifacts: [artifact], storyboard, validation: { passed: true, checks: [{ name: "storyboard_structure_revision", passed: true, detail: "结构操作已按冻结输入应用。" }] }, actualCostCents: 0, blockers: [], retry: { shouldRetry: false, reason: "Completed successfully." }, nextStep: "Submit the revised storyboard for Owner review." });
}

async function useWrittenStoryboard(taskPackage: WorkerTaskPackage, output: string): Promise<string> {
  const candidate = parseCodexOutput(output, 0);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("分镜结果格式无效。");
  const result = candidate as Record<string, unknown>;
  if (result.status !== "completed") return output;
  const relativePath = taskPackage.output.relativePath;
  const storyboard = addFrozenStoryboardBasis(JSON.parse(await readFile(join(taskPackage.assets.allowedRoot, relativePath), "utf8")), taskPackage.assets.inputs);
  const content = `${JSON.stringify(storyboard, null, 2)}\n`;
  await writeFile(join(taskPackage.assets.allowedRoot, relativePath), content);
  return JSON.stringify({ ...result, artifacts: refreshArtifactManifest(result.artifacts, relativePath, content), storyboard });
}

async function generateVisualAssets(taskPackage: WorkerTaskPackage, output: string): Promise<string> {
  const candidate = parseCodexOutput(output, 0);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("视觉资产准备结果格式无效。");
  const result = candidate as Record<string, unknown>;
  if (result.status !== "completed") return output;
  const requests = visualAssetRequests(result.visualAssetRequests);
  if (!requests.length) return output;
  const imageGeneration = taskPackage.visualAssetPreparation?.imageGeneration;
  if (!imageGeneration) throw new Error("视觉资产存在缺失项，但没有冻结的图片 Adapter。" );
  if ((imageGeneration.provider !== "openai" || imageGeneration.adapter !== "openai_images") && (imageGeneration.provider !== "cloudflare" || imageGeneration.adapter !== "workers_ai_images")) throw new Error("冻结的图片 Adapter 没有可用执行路径。" );
  const apiKey = await resolveConnectionSecret(imageGeneration.credentialRef, imageGeneration.provider, imageGeneration.adapter, taskPackage.accountId);
  if (!apiKey?.trim()) throw new Error("OPENAI_API_KEY 未配置，无法生成冻结视觉资产。" );
  const generated: ArtifactManifest[] = [];
  for (const request of requests) {
    const bytes = imageGeneration.provider === "cloudflare"
      ? await generateCloudflareWorkersAiImage({ credentials: apiKey, fetcher: fetch, model: imageGeneration.model, prompt: request.prompt })
      : await generateOpenAiImage({ apiKey, fetcher: fetch, model: imageGeneration.model, prompt: request.prompt });
    const relativePath = `episodes/${taskPackage.episode.id}/visuals/${request.id}.${imageGeneration.provider === "cloudflare" ? "jpg" : "png"}`;
    await writeSafeAssetFile(taskPackage.assets.allowedRoot, relativePath, bytes);
    generated.push({ artifactType: "static_visual", relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.byteLength });
  }
  if (!Array.isArray(result.artifacts)) throw new Error("视觉资产准备结果缺少产物清单。" );
  result.artifacts = [...result.artifacts, ...generated];
  return JSON.stringify(result);
}

function visualAssetRequests(value: unknown): VisualAssetRequest[] {
  if (!Array.isArray(value)) throw new Error("视觉资产准备缺少图片生成需求。" );
  return value.map((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("视觉图片生成需求格式无效。" );
    const value = request as Record<string, unknown>;
    if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) || typeof value.prompt !== "string" || !value.prompt.trim()) throw new Error("视觉图片生成需求格式无效。" );
    return { id: value.id, prompt: value.prompt, inputBasis: [] };
  });
}

async function preflightTask(taskPackage: WorkerTaskPackage): Promise<WorkerPreflightResult> {
  const capability = runtimeCapabilityFromTask(taskPackage);
  const imageGeneration = taskPackage.visualAssetPreparation?.imageGeneration;
  const connectionRef = imageGeneration?.credentialRef ?? taskPackage.credentialRef;
  const connectionProvider = imageGeneration?.provider ?? taskPackage.provider;
  const connectionAdapter = imageGeneration?.adapter ?? taskPackage.aRoll?.adapter ?? taskPackage.media?.adapter;
  const connectionModel = imageGeneration?.model ?? taskPackage.model;
  const capabilities = [capability, ...(imageGeneration ? [{ capability: "static_visual_generation", provider: connectionProvider, adapter: connectionAdapter, model: connectionModel, promptVersion: taskPackage.promptVersion, allowedTools: taskPackage.allowedTools, credentialRef: imageGeneration.credentialRef }] : [])];
  const credential = credentialEnvironmentForReference(connectionProvider, connectionAdapter, connectionRef);
  const command = capability.command;
  const commandStatus = command ? await workerCommandStatus(command) : undefined;
  const commands = command && commandStatus ? { [command]: commandStatus } : undefined;
  const localAdapters = commands ? localAdapterReadinessFromCommands(capabilities, commands) : undefined;
  const modelProbe = taskPackage.provider === "codex" && commandStatus?.available
    ? await probeCodexModel(taskPackage.model, (probeCommand, argumentsList, options) => runCommandWithOutput(probeCommand, argumentsList, options?.timeoutMs), tmpdir())
    : undefined;
  const apiKey = await resolveConnectionSecret(connectionRef, connectionProvider, connectionAdapter, taskPackage.accountId);
  const providerProbe = apiKey && connectionProvider !== "codex" ? await probeProviderConnection(connectionProvider, apiKey, fetch, connectionModel) : undefined;
  const connections = { ...(modelProbe ? { [taskPackage.provider]: modelProbe.connection } : {}), ...(providerProbe ? { [connectionProvider]: providerProbe.connection } : {}) };
  const modelPermissions = { ...(modelProbe ? { [taskPackage.model]: modelProbe.modelPermission } : {}), ...(providerProbe?.modelPermission ? { [connectionModel]: providerProbe.modelPermission } : {}) };
  const credentialValidity = providerProbe?.credentialValidity && (credential || connectionRef) ? { [credential ?? connectionRef!]: providerProbe.credentialValidity } : undefined;
  return createRuntimePreflight(capabilities, {
    credentials: credential ? { [credential]: Boolean(apiKey) } : connectionRef ? { [connectionRef]: Boolean(apiKey) } : undefined,
    ...(connectionRef ? { connectionReferences: { [connectionRef]: apiKey ? { available: true, detail: "外部连接引用已解析。" } : { available: false, detail: "外部连接秘密不可用。" } } } : {}),
    commands,
    ...(localAdapters ? { localAdapters } : {}),
    ...(Object.keys(connections).length ? { connections } : {}),
    ...(Object.keys(modelPermissions).length ? { modelPermissions } : {}),
    ...(credentialValidity ? { credentialValidity } : {}),
  });
}

async function resolveTaskSecret(taskPackage: WorkerTaskPackage): Promise<string | undefined> {
  return resolveConnectionSecret(taskPackage.credentialRef, taskPackage.provider, taskPackage.aRoll?.adapter ?? taskPackage.media?.adapter, taskPackage.accountId);
}

async function resolveConnectionSecret(credentialRef: string | undefined, provider: string, adapter: string | undefined, accountId: string): Promise<string | undefined> {
  if (credentialRef && isConnectionId(credentialRef)) {
    const { data, error } = await supabase.rpc("resolve_external_connection_secret", { p_account_id: accountId, p_connection_id: credentialRef });
    if (error) throw new Error("无法解析 Worker 外部连接秘密。");
    return typeof data === "string" && data.trim() ? data.trim() : undefined;
  }
  if (provider === "pexels" || provider === "openai" || provider === "cloudflare") return undefined;
  const credential = credentialEnvironmentForReference(provider, adapter, credentialRef);
  return credential ? process.env[credential]?.trim() : undefined;
}

function isConnectionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function workerCommandStatus(command: string): Promise<{ available: boolean; detail: string }> {
  try {
    const result = await runCommandWithOutput(command, runtimeCommandArguments(command));
    return { available: true, detail: result.stdout.split("\n")[0] || `${command} 可调用。` };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? `${command} 无法调用：${error.message}` : `${command} 无法调用。` };
  }
}

async function extractMp3Artifact(sourcePath: string, minimumDurationSeconds: number): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "loop-control-audio-"));
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

async function trimMp3Artifact(bytes: Uint8Array, targetDurationSeconds: number): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "loop-control-soundtrack-"));
  const inputPath = join(directory, "source.mp3");
  const outputPath = join(directory, "trimmed.mp3");
  try {
    await writeFile(inputPath, bytes);
    await runCommand("ffmpeg", ["-nostdin", "-v", "error", "-i", inputPath, "-t", String(targetDurationSeconds), "-codec:a", "libmp3lame", "-q:a", "2", outputPath]);
    const duration = await probeMp3Artifact(outputPath);
    if (duration + durationToleranceSeconds() < targetDurationSeconds) throw new Error(`Freesound 裁剪后的音频时长不足：${duration} 秒。`);
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function trimMp4Artifact(sourcePath: string, startSeconds: number, endSeconds: number): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "loop-control-video-"));
  const outputPath = join(directory, "trimmed.mp4");
  try {
    const durationSeconds = endSeconds - startSeconds;
    await runCommand("ffmpeg", ["-nostdin", "-v", "error", "-i", sourcePath, "-ss", String(startSeconds), "-t", String(durationSeconds), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath]);
    const { stdout } = await runCommandWithOutput("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", outputPath]);
    const inspected = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    const actualDuration = Number(inspected.format?.duration);
    const hasVideo = Boolean(inspected.streams?.some((stream) => stream.codec_type === "video"));
    const hasAudio = Boolean(inspected.streams?.some((stream) => stream.codec_type === "audio"));
    if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - durationSeconds) > durationToleranceSeconds() || !hasVideo) throw new Error(`裁剪视频校验失败：时长 ${actualDuration || "未知"} 秒，视频流 ${hasVideo ? "存在" : "缺失"}，音频流 ${hasAudio ? "存在" : "缺失"}。`);
    const bytes = new Uint8Array(await readFile(outputPath));
    if (bytes.byteLength === 0) throw new Error("裁剪视频文件为空。");
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function trimMp4SegmentsArtifact(sourcePath: string, segments: Array<{ startSeconds: number; endSeconds: number }>): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "loop-control-video-segments-"));
  const outputPath = join(directory, "combined.mp4");
  try {
    const segmentPaths: string[] = [];
    for (const [index, segment] of segments.entries()) {
      const segmentPath = join(directory, `segment-${index}.mp4`);
      await runCommand("ffmpeg", ["-nostdin", "-v", "error", "-i", sourcePath, "-ss", String(segment.startSeconds), "-t", String(segment.endSeconds - segment.startSeconds), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-movflags", "+faststart", segmentPath]);
      segmentPaths.push(segmentPath);
    }
    const concatPath = join(directory, "segments.txt");
    await writeFile(concatPath, segmentPaths.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
    await runCommand("ffmpeg", ["-nostdin", "-v", "error", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", "-movflags", "+faststart", outputPath]);
    const bytes = new Uint8Array(await readFile(outputPath));
    if (bytes.byteLength === 0) throw new Error("拼接视频文件为空。");
    return bytes;
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

async function validateMp4Artifact(path: string, minimumDurationSeconds: number, frameRate?: number, allowedFrames?: number): Promise<void> {
  const { stdout } = await runCommandWithOutput("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
  ]);
  const duration = Number(stdout.trim());
  if (!videoDurationMeetsMinimum(duration, minimumDurationSeconds, frameRate, allowedFrames)) {
    throw new Error(`视频不可播放或时长不足：${duration || "未知"} 秒。`);
  }
}

async function inspectMp4Artifact(path: string): Promise<{ durationSeconds: number; width: number; height: number; hasAudio: boolean; blackFrameCount: number }> {
  const { stdout } = await runCommandWithOutput("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path]);
  const inspected = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
  const durationSeconds = Number(inspected.format?.duration);
  const video = inspected.streams?.find((stream) => stream.codec_type === "video");
  if (!Number.isFinite(durationSeconds) || !video || !Number.isInteger(video.width) || !Number.isInteger(video.height)) throw new Error("最终视频缺少有效的时长或视频流。");
  const black = await runCommandWithOutput("ffmpeg", ["-nostdin", "-v", "info", "-i", path, "-vf", "blackdetect=d=0.1:pix_th=0.02", "-an", "-f", "null", "-"]);
  return { durationSeconds, width: Number(video.width), height: Number(video.height), hasAudio: Boolean(inspected.streams?.some((stream) => stream.codec_type === "audio")), blackFrameCount: (black.stderr.match(/black_start:/g) ?? []).length };
}

async function reportResult(taskId: string, attempt: number, workerResult: unknown): Promise<void> {
  try {
    const { error } = await supabase.rpc("report_worker_result", {
      p_task_id: taskId,
      p_attempt: attempt,
      p_result: workerResult,
    });
    if (error) throw new Error(`Unable to report the worker result: ${error.message}`);
  } finally {
    stopLeaseHeartbeat();
  }
}

async function reportProgress(taskId: string, attempt: number, progress: WorkerProgress): Promise<void> {
  const value = { version: "worker-progress/v1", progress };
  const { error: taskError } = await supabase.from("tasks").update({ last_result: value }).eq("id", taskId).eq("attempt", attempt).eq("status", "running");
  if (taskError) throw new Error(`Unable to report Worker progress: ${taskError.message}`);
  const { error: runError } = await supabase.from("task_runs").update({ result: value }).eq("task_id", taskId).eq("attempt", attempt).eq("status", "running");
  if (runError) throw new Error(`Unable to report Worker run progress: ${runError.message}`);
}

function startLeaseHeartbeat(taskId: string, attempt: number): void {
  stopLeaseHeartbeat();
  leaseHeartbeat = setInterval(() => {
    void (async () => {
      try {
        const { error } = await supabase.rpc("refresh_worker_task_lease", { p_task_id: taskId, p_attempt: attempt });
        if (error) process.stderr.write(`Unable to refresh the worker lease: ${error.message}\n`);
      } catch (error) {
        process.stderr.write(`Unable to refresh the worker lease: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    })();
  }, workerLeaseHeartbeatMs);
  leaseHeartbeat.unref?.();
}

function stopLeaseHeartbeat(): void {
  if (!leaseHeartbeat) return;
  clearInterval(leaseHeartbeat);
  leaseHeartbeat = undefined;
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
  const directory = await mkdtemp(join(tmpdir(), "loop-control-codex-"));
  const schemaPath = join(directory, "worker-result.schema.json");
  const resultPath = join(directory, "result.json");
  try {
    await writeFile(schemaPath, JSON.stringify(workerResultJsonSchema(taskPackage.capability)));
    await runCommand("codex", [
      "exec",
      "--approve-for-me",
      "--ephemeral",
      "--skip-git-repo-check",
      "--cd", taskPackage.assets.allowedRoot,
      "--model", taskPackage.model,
      "--output-schema", schemaPath,
      "--output-last-message", resultPath,
      buildCodexPrompt(taskPackage),
    ], codexExecutionTimeoutMs);
    return await readFile(resultPath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function buildCodexPrompt(taskPackage: WorkerTaskPackage): string {
  return [
    "You are the Codex Content Worker for a controlled production platform.",
    "Work only inside assets.allowedRoot. Do not inspect, modify, or transmit files outside that directory.",
    "Use only the tools listed in allowedTools. If the task cannot be completed with them, return blocked instead of substituting another tool.",
    "allowedTools is a capability policy, not a list of Codex tool names. When it includes read and write, use your normal workspace filesystem tools only to read and write within assets.allowedRoot.",
    "When task package includes seriesBaseline, it is an approved, frozen reusable base. For visual planning, do not regenerate covered characters, voices, or visual references; create only additions or explicit deviations. When visualAssetPreparation is present, write the required visual_asset_manifest as Markdown: list every frozen external visual input by its role, list only the missing character, location, prop, or key-frame needs, and cite the frozen input paths that justify each item. Also return visualAssetRequests: [] when external assets fully cover the need; otherwise return one request per missing item, each with a lowercase kebab-case id, an explicit image prompt, and inputBasis paths/hashes drawn only from frozen inputs. Do not create SVGs, placeholder images, or a static_visual artifact yourself. The registered image Adapter will create only the returned missing requests; without one, return blocked rather than claiming completion.",
    "For a completed storyboard_planning task, write the primary artifact as valid JSON and also return the identical object in result.storyboard. It must have version storyboard/v1, a non-empty shots array, and an audioCues array (empty when no BGM/SFX is needed). Every shot needs id, scriptSegment, durationSeconds, shotType (a_roll or b_roll), productionMethod, inputBasis (objects containing each frozen input's relativePath and sha256), and targetSpec. Each optional audio cue needs id, kind (bgm or sfx), description, searchQuery, startSeconds, and durationSeconds. description is the Owner-facing display text; searchQuery is a concise English Freesound search phrase of at most 100 characters. Each shot must include the frozen main script and at least one approved visual input. For a blocked or failed storyboard_planning task, set result.storyboard to null. Do not generate or queue A-roll, B-roll, or audio media; this task is only the reviewable storyboard. When reviewAnnotations are present, revise the matching shot IDs to address their reasons.",
    "For a_roll_generation, create only the frozen shot in aRoll with its declared aRoll.adapter. Do not replace the adapter, add other shots, scan for newer inputs, or advance an Episode stage. Use only aRoll.shot.inputBasis and produce the frozen video output contract; if the declared adapter cannot produce that output, return blocked with an explicit blocker.",
    "Do not approve, publish, change any blueprint, call platform APIs, or change an Episode stage.",
    "If any required input, tool, permission, or rule is missing, return status blocked with explicit blockers; do not silently substitute a provider.",
    ...(taskPackage.promptHarness ? ["Frozen Prompt Harness (follow it unless it conflicts with the fixed safety rules above):", taskPackage.promptHarness.content] : []),
    `Create the required artifact at output.relativePath inside episodes/${taskPackage.episode.id}/ and return a JSON result that matches the provided schema. Use paths relative to assets.allowedRoot and SHA-256 hashes in lowercase hexadecimal.`,
    "The retry reason must always be non-empty. For a completed result, set retry.shouldRetry to false and retry.reason to Completed successfully.",
    "Task package:",
    JSON.stringify(taskPackage),
  ].join("\n\n");
}

function runCommand(command: string, argumentsList: string[], timeoutMs?: number): Promise<void> {
  return runCommandWithOutput(command, argumentsList, timeoutMs).then(() => undefined);
}

function runCommandWithOutput(command: string, argumentsList: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const invocation = runtimeCommandInvocation(command, argumentsList);
    const child = spawn(invocation.command, invocation.argumentsList, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = timeoutMs ? setTimeout(() => {
      child.kill("SIGTERM");
      if (settled) return;
      settled = true;
      reject(new Error(`${command} 执行超时。`));
    }, timeoutMs) : undefined;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Codex exited with status ${code ?? "unknown"}.`));
    });
  });
}
