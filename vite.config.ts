import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createClient } from "@supabase/supabase-js";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { loadEnv, type Plugin } from "vite";
import { verifyMediaLibrary } from "./src/worker/mediaLibrary";
import { createRuntimePreflight, localAdapterReadinessFromCommands, runtimeCapabilitiesFromBlueprintPolicy, runtimeCommandArguments, runtimeCommandInvocation } from "./src/worker/runtimePreflight";
import { probeCodexModel, probeProviderConnection } from "./src/worker/runtimeProbes";
import { isSupportedManualARollVideo, isSupportedManualAudio } from "./src/reviews/materialImport";
import { workerPreflightVersion } from "./src/worker/contracts";
import { writeSafeAssetFile } from "./src/worker/controlledMediaExecutor";
import { createPublishPackage, verifyPublishPackage } from "./src/publishing/publishPackage";
import { loadPublishContext } from "./src/publishing/publishContext";
import { coverImageExtension, coverInputPath } from "./src/publishing/coverImage";
import { registeredAdapters } from "./src/worker/registeredAdapters";
import { synthesizeGoogleTts, synthesizeVolcengineTts } from "./src/worker/mediaProviders";
import { reviewRenderFromSnapshot, shotPreparationContractFromSnapshot } from "./src/worker/codexRunner";
import { freezeOpenChatCutStudio, openOpenChatCutStudio } from "./src/worker/openchatcutStudio";
import type { ShotPreparationContract, StoryboardManifest, WorkerTaskPackage } from "./src/worker/contracts";
import { ExpiringProbeCache, summarizeN8nExecutions, supabaseControlDataEvidence, type N8nExecutionEvidence, type N8nExecutionEvidenceRow } from "./src/observability/systemStatusEvidence";

export { coverImageExtension } from "./src/publishing/coverImage";
const localArtifactRoute = "/_local-artifact";
const localEpisodeDirectoryRoute = "/_local-episode-directory";
const openLocalEpisodeDirectoryRoute = "/_open-local-episode-directory";
const chooseLocalAssetDirectoryRoute = "/_choose-local-asset-directory";
const openLocalAssetDirectoryRoute = "/_open-local-asset-directory";
const openLocalArtifactRoute = "/_open-local-artifact";
const localProductionMaterialRoute = "/_production-material";
const localEpisodeDeletionRoute = "/_delete-episode";
const localEpisodeDeletionCleanupRoute = "/_finalize-episode-deletion";
const systemStatusRoute = "/_system-status";
const goldenProductionTestRoute = "/_golden-production-test";
const workerPreflightRoute = "/_worker-preflight";
const externalConnectionTestRoute = "/_external-connection-test";
const publishPreparationRoute = "/_publish-preparation";
const openOpenChatCutStudioRoute = "/_open-openchatcut-studio";
const freezeOpenChatCutStudioRoute = "/_freeze-openchatcut-studio";
const episodePreflightRoute = "/_episode-preflight";
const episodeDispatchRoute = "/_episode-dispatch";
const ttsVoicePreviewRoute = "/_tts-voice-preview";
const maxProductionMaterialBytes = 100 * 1024 * 1024;
const maxEncodedMaterialRequestBytes = 140 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const storyboardThumbnailInFlight = new Map<string, Promise<LocalArtifactFile>>();
const episodeDispatchInFlight = new Map<string, Promise<void>>();
const taskDispatchInFlight = new Map<string, Promise<void>>();
export type TaskDispatchStatus = { detail: string; status: "failed" | "starting" | "succeeded" | "unknown"; updatedAt: string | null };
const taskDispatchStatuses = new Map<string, TaskDispatchStatus>();

type LocalArtifactFile = { modifiedAt: number; path: string; size: number };

const mediaTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function isSafeRelativeArtifactPath(value: string): boolean {
  return value.length > 0 && !value.split(/[\\/]/).some((segment) => !segment || segment === "." || segment === "..");
}

function isEpisodeId(value: string): boolean {
  return isUuid(value);
}

export function beginEpisodeDispatch(episodeId: string, run: (episodeId: string) => Promise<unknown> = async (id) => runProbeCommand(join(process.cwd(), "n8n", "run-orchestrator.sh"), ["dispatch", "--episode", id], 30 * 60 * 1000)): "started" | "already_running" {
  if (episodeDispatchInFlight.has(episodeId)) return "already_running";
  const operation = run(episodeId).then(() => undefined).catch((error) => {
    console.error(`Episode ${episodeId} 即时派发失败：`, error);
  }).finally(() => {
    if (episodeDispatchInFlight.get(episodeId) === operation) episodeDispatchInFlight.delete(episodeId);
  });
  episodeDispatchInFlight.set(episodeId, operation);
  return "started";
}

const requiredWorkerDispatchEnvironment = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CODEX_WORKER_ACTUAL_COST_CENTS", "MEDIA_LIBRARY_MOUNT_PATH", "MEDIA_LIBRARY_MIN_FREE_BYTES"] as const;

export function assertWorkerDispatchEnvironment(contents: string): void {
  const values = new Map<string, string>();
  for (const sourceLine of contents.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const rawValue = match[2].trim();
    const value = rawValue.length >= 2 && ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) ? rawValue.slice(1, -1).trim() : rawValue;
    values.set(match[1], value);
  }
  const missing = requiredWorkerDispatchEnvironment.filter((name) => !values.get(name));
  if (missing.length) throw new Error(`Worker 即时派发配置不完整：${missing.join("、")}`);
}

export function taskDispatchInvocation(projectRoot: string, taskId: string): { argumentsList: string[]; command: string } {
  return { argumentsList: ["--task-id", taskId], command: join(projectRoot, "n8n", "run-worker.sh") };
}

export function beginTaskDispatch(taskId: string, run?: (taskId: string) => Promise<unknown>): "started" | "already_running" {
  if (taskDispatchInFlight.has(taskId)) return "already_running";
  let execute = run;
  if (!execute) {
    const projectRoot = process.cwd();
    const workerEnvironmentPath = join(projectRoot, "n8n", "worker.env.local");
    let workerEnvironment = "";
    try { workerEnvironment = readFileSync(workerEnvironmentPath, "utf8"); }
    catch { throw new Error("Worker 即时派发尚未配置：缺少 n8n/worker.env.local。"); }
    assertWorkerDispatchEnvironment(workerEnvironment);
    execute = async (id) => {
      const invocation = taskDispatchInvocation(projectRoot, id);
      return runProbeCommand(invocation.command, invocation.argumentsList, 30 * 60 * 1000);
    };
  }
  taskDispatchStatuses.set(taskId, { detail: "Worker 进程正在启动。", status: "starting", updatedAt: new Date().toISOString() });
  const operation = execute(taskId).then(() => {
    taskDispatchStatuses.set(taskId, { detail: "Worker 进程已结束，任务结果已写回。", status: "succeeded", updatedAt: new Date().toISOString() });
  }).catch((error) => {
    const detail = error instanceof Error ? error.message : "Worker 进程启动或执行失败。";
    taskDispatchStatuses.set(taskId, { detail, status: "failed", updatedAt: new Date().toISOString() });
    console.error(`Task ${taskId} 即时派发失败：`, error);
  }).finally(() => {
    if (taskDispatchInFlight.get(taskId) === operation) taskDispatchInFlight.delete(taskId);
  });
  taskDispatchInFlight.set(taskId, operation);
  return "started";
}

export function taskDispatchStatus(taskId: string): TaskDispatchStatus {
  return taskDispatchStatuses.get(taskId) ?? { detail: "当前服务没有这次即时派发记录。", status: "unknown", updatedAt: null };
}

export function serveEpisodeDispatch(
  supabaseUrl: string | undefined,
  supabasePublishableKey: string | undefined,
  dispatch: (taskId: string) => "started" | "already_running" = beginTaskDispatch,
  readStatus: (taskId: string) => TaskDispatchStatus = taskDispatchStatus,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST" && request.method !== "GET") { response.statusCode = 405; response.end(); return; }
    const authorization = request.headers.authorization ?? "";
    const episodeId = new URL(request.url ?? "", "http://localhost").searchParams.get("episode") ?? "";
    const taskId = new URL(request.url ?? "", "http://localhost").searchParams.get("task") ?? "";
    if (!authorization.startsWith("Bearer ") || !isEpisodeId(episodeId) || !isUuid(taskId)) { response.statusCode = 400; response.end("缺少有效的 Owner 会话、Episode ID 或 Task ID。"); return; }
    if (!supabaseUrl || !supabasePublishableKey) { response.statusCode = 503; response.end("Supabase 本地客户端未配置。"); return; }
    try {
      const accessToken = authorization.slice("Bearer ".length);
      const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
      const { data: userData, error: userError } = await client.auth.getUser(accessToken);
      if (userError || !userData.user) { response.statusCode = 401; response.end("Owner 登录会话无效。"); return; }
      const { data: episode, error: episodeError } = await client.from("episodes").select("account_id").eq("id", episodeId).maybeSingle();
      if (episodeError) throw episodeError;
      if (!episode) { response.statusCode = 404; response.end("未找到当前 Episode。"); return; }
      const { data: membership, error: membershipError } = await client.from("account_memberships").select("role").eq("account_id", episode.account_id).eq("user_id", userData.user.id).eq("role", "owner").maybeSingle();
      if (membershipError) throw membershipError;
      if (!membership) { response.statusCode = 403; response.end("Owner 权限不足。"); return; }
      const { data: task, error: taskError } = await client.from("tasks").select("id").eq("id", taskId).eq("episode_id", episodeId).in("status", ["ready", "running"]).maybeSingle();
      if (taskError) throw taskError;
      if (!task) { response.statusCode = 404; response.end("未找到可派发的当前任务。"); return; }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") {
        response.statusCode = 200;
        response.end(JSON.stringify(readStatus(taskId)));
        return;
      }
      response.statusCode = 202;
      response.end(JSON.stringify({ status: dispatch(taskId) }));
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "无法即时派发当前生产单。");
    }
  };
}

export function confirmedStudioShotBlockers(context: unknown, drafts: readonly unknown[]): string[] {
  const snapshot = context && typeof context === "object" && !Array.isArray(context) ? context as Record<string, unknown> : {};
  const storyboard = snapshot.storyboard && typeof snapshot.storyboard === "object" && !Array.isArray(snapshot.storyboard) ? snapshot.storyboard as Record<string, unknown> : {};
  const shots = Array.isArray(storyboard.shots) ? storyboard.shots : [];
  const confirmedShots = Array.isArray(snapshot.confirmed_shots) ? snapshot.confirmed_shots : [];
  const members = Array.isArray(snapshot.members) ? snapshot.members : [];
  const draftByShot = new Map<string, Record<string, unknown>>();
  const confirmedByShot = new Map<string, Record<string, unknown>>();
  const memberByKey = new Map<string, Record<string, unknown>>();
  for (const draft of drafts) {
    if (draft && typeof draft === "object" && !Array.isArray(draft) && typeof (draft as Record<string, unknown>).shot_id === "string") draftByShot.set((draft as Record<string, unknown>).shot_id as string, draft as Record<string, unknown>);
  }
  for (const confirmedShot of confirmedShots) {
    if (confirmedShot && typeof confirmedShot === "object" && !Array.isArray(confirmedShot) && typeof (confirmedShot as Record<string, unknown>).shot_id === "string") confirmedByShot.set((confirmedShot as Record<string, unknown>).shot_id as string, confirmedShot as Record<string, unknown>);
  }
  for (const member of members) {
    if (member && typeof member === "object" && !Array.isArray(member) && typeof (member as Record<string, unknown>).member_key === "string") memberByKey.set((member as Record<string, unknown>).member_key as string, member as Record<string, unknown>);
  }

  const blockers: string[] = [];
  for (const shot of shots) {
    const shotId = shot && typeof shot === "object" && !Array.isArray(shot) && typeof (shot as Record<string, unknown>).id === "string" ? (shot as Record<string, unknown>).id as string : "未知镜头";
    const confirmed = confirmedByShot.get(shotId);
    const draft = draftByShot.get(shotId);
    const media = memberByKey.get(`shot:${shotId}`);
    const audio = memberByKey.get(`narration:${shotId}`);
    const audioMode = confirmed?.audio_mode;
    const rawSourceMatches = typeof confirmed?.source_material_revision_id === "string"
      && draft?.selected_material_revision_id === confirmed.source_material_revision_id
      && media?.source_material_revision_id === confirmed.source_material_revision_id
      && JSON.stringify(draft.clip_segments) === JSON.stringify(confirmed.clip_segments)
      && JSON.stringify(media.clip_segments) === JSON.stringify(confirmed.clip_segments);
    const preparedClipMatches = typeof confirmed?.video_artifact_id === "string" && typeof confirmed.video_task_id === "string"
      && draft?.current_video_artifact_id === confirmed.video_artifact_id
      && draft?.current_video_task_id === confirmed?.video_task_id
      && media?.artifact_id === confirmed?.video_artifact_id
      && media?.task_id === confirmed?.video_task_id;
    const embeddedSourceAudio = rawSourceMatches && audioMode === "source";
    const valid = confirmed?.confirmation_status === "confirmed"
      && draft?.confirmation_status === "confirmed"
      && draft.input_fingerprint === confirmed.input_fingerprint
      && (rawSourceMatches || preparedClipMatches)
      && draft.audio_mode === audioMode
      && draft.current_audio_track_id === confirmed.audio_track_id
      && draft.subtitle_text === confirmed.subtitle_text
      && draft.subtitles_enabled === confirmed.subtitles_enabled
      && (audioMode === "none" || embeddedSourceAudio ? !audio : Boolean(audio && audio.audio_track_id === confirmed.audio_track_id))
      && Boolean(media && media.input_fingerprint === confirmed.input_fingerprint
        && media.audio_mode === confirmed.audio_mode
        && media.subtitle_text === confirmed.subtitle_text
        && media.subtitles_enabled === confirmed.subtitles_enabled);
    if (!valid) blockers.push(shotId);
  }
  return [...new Set(blockers)];
}

export function requiredMediaCapabilitiesFromTasks(tasks: unknown): string[] {
  if (!Array.isArray(tasks)) return [];
  const capabilities = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) continue;
    const record = task as Record<string, unknown>;
    if (record.status === "completed" || record.status === "superseded" || record.provider === "manual_upload") continue;
    const taskType = record.task_type;
    const capability = taskType === "generate_b_roll" ? "b_roll_generation"
      : taskType === "generate_narration" ? "narration_generation"
        : taskType === "generate_soundtrack" ? "soundtrack_generation"
          : taskType === "generate_a_roll" ? "a_roll_generation"
            : taskType === "generate_static_visual" ? "static_visual_generation" : null;
    if (capability) capabilities.add(capability);
    const snapshot = record.input_snapshot;
    if (taskType === "prepare_visual_brief" && snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      const visualAssets = (snapshot as Record<string, unknown>).visual_assets;
      const imageGeneration = visualAssets && typeof visualAssets === "object" && !Array.isArray(visualAssets) ? (visualAssets as Record<string, unknown>).image_generation : undefined;
      if (imageGeneration && typeof imageGeneration === "object" && !Array.isArray(imageGeneration) && (imageGeneration as Record<string, unknown>).provider !== "manual_upload") capabilities.add("static_visual_generation");
    }
  }
  return [...capabilities];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isDescendant(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return pathFromParent.length > 0 && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}

function isFilesystemRoot(path: string): boolean {
  const resolvedPath = resolve(path);
  return parse(resolvedPath).root === resolvedPath;
}

export interface ShotWorkbenchStudioInput {
  allowedFrames: number;
  audioTracks: Array<{ id?: string; cueId: string; relativePath: string; sha256: string; startSeconds: number; durationSeconds: number }>;
  drafts: Array<{ audioMode: "none" | "source" | "tts"; audioTrackId: string | null; clipSegments: Array<{ startSeconds: number; endSeconds: number }>; composition: ShotPreparationContract["composition"]; confirmationStatus: "confirmed"; inputFingerprint: string; materialRevisionId: string | null; preparationContract: ShotPreparationContract; shotId: string; subtitleText: string; subtitlesEnabled: boolean; ttsText: string | null; videoArtifactId: string | null; videoTaskId: string | null }>;
  frameRate: number;
  materials: Array<{ id: string; relativePath: string; sha256: string }>;
  storyboard: StoryboardManifest;
}

export function parseShotWorkbenchClipSegments(value: unknown): Array<{ startSeconds: number; endSeconds: number }> {
  if (!Array.isArray(value)) return [];
  return value.map((segment) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) throw new Error("Studio 片段标记无效。");
    const record = segment as Record<string, unknown>;
    const startSeconds = record.start_seconds;
    const endSeconds = record.end_seconds;
    if (typeof startSeconds !== "number" || !Number.isFinite(startSeconds) || startSeconds < 0 || typeof endSeconds !== "number" || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) throw new Error("Studio 片段标记无效。");
    return { startSeconds, endSeconds };
  });
}

export function shotWorkbenchReviewRender(episodeId: string, projectRelativePath: string, input: ShotWorkbenchStudioInput): NonNullable<WorkerTaskPackage["reviewRender"]> {
  if (!isEpisodeId(episodeId)) throw new Error("无效的 Episode ID。");
  const materialById = new Map(input.materials.map((material) => [material.id, material]));
  const trackByCueId = new Map(input.audioTracks.map((track) => [track.cueId, track]));
  const members: NonNullable<WorkerTaskPackage["reviewRender"]>["members"] = [];
  let timelineStartSeconds = 0;
  for (const shot of input.storyboard.shots) {
    const draft = input.drafts.find((candidate) => candidate.shotId === shot.id);
    const material = draft?.materialRevisionId ? materialById.get(draft.materialRevisionId) : undefined;
    const segments = draft?.clipSegments?.length ? draft.clipSegments : [{ startSeconds: 0, endSeconds: shot.durationSeconds }];
    const durationSeconds = segments.reduce((total, segment) => total + segment.endSeconds - segment.startSeconds, 0);
    members.push({
      memberKey: `shot:${shot.id}`,
      memberKind: "shot_media",
      mediaMissing: !material,
      sourceMaterialRevisionId: material?.id,
      clipSegments: segments,
      composition: draft?.composition,
      preparationContract: draft?.preparationContract,
      inputFingerprint: draft?.inputFingerprint,
      audioTrackId: draft?.audioTrackId,
      audioMode: draft?.audioMode ?? "none",
      relativePath: material?.relativePath ?? `episodes/${episodeId}/studio-work/missing-${members.length}.mp4`,
      sha256: material?.sha256 ?? "0".repeat(64),
      subtitleText: draft?.subtitlesEnabled === false ? "" : draft?.subtitleText ?? shot.scriptSegment,
      subtitlesEnabled: draft?.subtitlesEnabled !== false,
      startSeconds: timelineStartSeconds,
      durationSeconds,
    });
    const track = trackByCueId.get(shot.id);
    if (draft?.audioMode === "tts" && track) {
      members.push({
        memberKey: `narration:${shot.id}`,
        memberKind: "narration",
        audioTrackId: track.id ?? track.cueId,
        audioMode: "tts",
        relativePath: track.relativePath,
        sha256: track.sha256,
        startSeconds: timelineStartSeconds + track.startSeconds,
        durationSeconds: track.durationSeconds,
      });
    }
    timelineStartSeconds += durationSeconds;
  }
  return {
    compositionId: "shot-workbench",
    projectRelativePath,
    projectRevision: 1,
    preRenderReviewPackageId: "shot-workbench",
    confirmationMode: "shot_preparation",
    confirmedShots: input.storyboard.shots.map((shot) => {
      const draft = input.drafts.find((candidate) => candidate.shotId === shot.id);
      if (!draft) throw new Error(`镜头 ${shot.id} 缺少当前版本化准备契约。`);
      return {
        shotId: shot.id,
        confirmationStatus: draft.confirmationStatus,
        inputFingerprint: draft.inputFingerprint,
        ...(draft.videoArtifactId ? { videoArtifactId: draft.videoArtifactId } : {}),
        ...(draft.videoTaskId ? { videoTaskId: draft.videoTaskId } : {}),
        ...(draft.materialRevisionId ? { sourceMaterialRevisionId: draft.materialRevisionId, clipSegments: draft.clipSegments } : {}),
        composition: draft.composition,
        preparationContract: draft.preparationContract,
        audioMode: draft.audioMode,
        audioTrackId: draft.audioTrackId,
        subtitleText: draft.subtitleText,
        subtitlesEnabled: draft.subtitlesEnabled,
      };
    }),
    adjustments: {
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      captionsEnabled: true,
      captionStyle: "minimal",
      pacing: "standard",
      crop: "cover",
      transition: "cut",
      layout: "lower_third",
      narrationGainDb: 0,
      bgmGainDb: -12,
      sfxGainDb: -6,
      frameRate: input.frameRate,
      allowedFrames: input.allowedFrames,
      reason: "镜头工作版本",
    },
    storyboard: input.storyboard,
    members,
  };
}

function isStoryboardThumbnailVideo(path: string): boolean {
  return [".mov", ".mp4", ".webm"].includes(extname(path).toLowerCase());
}

async function renderStoryboardVideoThumbnail(sourcePath: string, destinationPath: string): Promise<void> {
  let timestamp = 0;
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", sourcePath]);
    const duration = Number(stdout.trim());
    if (Number.isFinite(duration) && duration > 0) timestamp = Math.min(Math.max(duration * 0.1, 0.5), Math.max(duration - 0.05, 0));
  } catch {
    // The first decoded frame remains a usable fallback for malformed duration metadata.
  }
  await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(timestamp), "-i", sourcePath, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=320:-2", "-an", "-pix_fmt", "yuvj420p", "-q:v", "4", "-y", destinationPath]);
}

export async function cachedStoryboardVideoThumbnail(assetRoot: string, sourcePath: string, identity: { modifiedAt: number; sha256: string }, render: (sourcePath: string, destinationPath: string) => Promise<void> = renderStoryboardVideoThumbnail): Promise<LocalArtifactFile> {
  const resolvedRoot = await fs.realpath(assetRoot);
  if (isFilesystemRoot(resolvedRoot)) throw new Error("资产根不能是文件系统根目录。");
  const cacheRoot = await ensureDirectoryWithinRoot(resolvedRoot, resolve(resolvedRoot, ".cache"));
  const cacheDirectory = await ensureDirectoryWithinRoot(cacheRoot, resolve(cacheRoot, "storyboard-thumbnails"));
  const cacheKey = createHash("sha256").update(JSON.stringify({ version: "storyboard-keyframe/v1", ...identity })).digest("hex");
  const cachePath = resolve(cacheDirectory, `${cacheKey}.jpg`);
  try {
    const cached = await fs.stat(cachePath);
    if (cached.isFile() && cached.size > 0) return { modifiedAt: cached.mtimeMs, path: cachePath, size: cached.size };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const inFlight = storyboardThumbnailInFlight.get(cachePath);
  if (inFlight) return inFlight;
  const pending = (async () => {
    const temporaryPath = resolve(cacheDirectory, `.${cacheKey}.${randomUUID()}.jpg`);
    try {
      await render(sourcePath, temporaryPath);
      const temporary = await fs.stat(temporaryPath);
      if (!temporary.isFile() || temporary.size === 0) throw new Error("视频关键帧缩略图为空。");
      try {
        await fs.link(temporaryPath, cachePath);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      const cached = await fs.stat(cachePath);
      return { modifiedAt: cached.mtimeMs, path: cachePath, size: cached.size };
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  })();
  storyboardThumbnailInFlight.set(cachePath, pending);
  try {
    return await pending;
  } finally {
    if (storyboardThumbnailInFlight.get(cachePath) === pending) storyboardThumbnailInFlight.delete(cachePath);
  }
}

export function serveLocalArtifact(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  const verifiedArtifacts = new Map<string, { assetRoot: string; expiresAt: number; modifiedAt: number; path: string; sha256: string; size: number }>();
  const previewTickets = new Map<string, { expiresAt: number; modifiedAt: number; path: string; size: number }>();

  function sendArtifact(request: IncomingMessage, response: ServerResponse, next: (error?: Error) => void, artifact: { path: string; size: number }): void {
    const rangeHeader = request.headers.range;
    let start = 0;
    let end = artifact.size - 1;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match || (!match[1] && !match[2])) {
        response.statusCode = 416;
        response.setHeader("Content-Range", `bytes */${artifact.size}`);
        response.end();
        return;
      }
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), artifact.size - 1) : artifact.size - 1;
      } else {
        const suffixLength = Number(match[2]);
        start = Math.max(artifact.size - suffixLength, 0);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= artifact.size) {
        response.statusCode = 416;
        response.setHeader("Content-Range", `bytes */${artifact.size}`);
        response.end();
        return;
      }
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${artifact.size}`);
    }
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", mediaTypes[extname(artifact.path).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("Content-Length", end - start + 1);
    if (request.method === "HEAD") response.end();
    else createReadStream(artifact.path, rangeHeader ? { end, start } : undefined).on("error", next).pipe(response);
  }

  function issueTicket(response: ServerResponse, artifact: { modifiedAt: number; path: string; size: number }): void {
    // ponytail: in-memory 100-ticket/30-minute grant; use signed URLs only if preview moves beyond this local process.
    if (previewTickets.size >= 100) previewTickets.delete(previewTickets.keys().next().value!);
    const ticket = randomUUID();
    previewTickets.set(ticket, { ...artifact, expiresAt: Date.now() + 30 * 60_000 });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ url: `${localArtifactRoute}?ticket=${encodeURIComponent(ticket)}` }));
  }

  return async (request: IncomingMessage, response: ServerResponse, next: (error?: Error) => void): Promise<void> => {
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    response.statusCode = 405;
    response.end();
    return;
  }

  const url = new URL(request.url ?? "", "http://127.0.0.1");
  const ticket = url.searchParams.get("ticket");
  if (ticket && (request.method === "GET" || request.method === "HEAD")) {
    const granted = previewTickets.get(ticket);
    if (granted && granted.expiresAt > Date.now()) {
      try {
        const artifact = await fs.stat(granted.path);
        if (artifact.isFile() && artifact.size === granted.size && artifact.mtimeMs === granted.modifiedAt) {
          sendArtifact(request, response, next, granted);
          return;
        }
      } catch {
        // Fall through to the same opaque not-found response used for expired grants.
      }
    }
    previewTickets.delete(ticket);
    response.statusCode = 404;
    response.end("未找到可预览产物。");
    return;
  }
  const episodeId = url.searchParams.get("episode") ?? "";
  const relativePath = url.searchParams.get("path") ?? "";
  const expectedSha256 = url.searchParams.get("sha256");
  const thumbnail = url.searchParams.get("thumbnail");
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    response.statusCode = 401;
    response.end("需要 Owner 登录会话。");
    return;
  }
  if (!episodeId || !isSafeRelativeArtifactPath(relativePath)) {
    response.statusCode = 400;
    response.end("无效的本地产物路径。");
    return;
  }
  if (thumbnail && thumbnail !== "keyframe") {
    response.statusCode = 400;
    response.end("不支持的缩略图类型。");
    return;
  }
  if (thumbnail === "keyframe" && !isStoryboardThumbnailVideo(relativePath)) {
    response.statusCode = 400;
    response.end("仅视频素材支持关键帧缩略图。");
    return;
  }
  const cacheKey = createHash("sha256").update(`${authorization}\n${episodeId}\n${relativePath}\n${expectedSha256 ?? ""}`).digest("hex");
  const cached = verifiedArtifacts.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    try {
      const artifact = await fs.stat(cached.path);
      if (artifact.isFile() && artifact.size === cached.size && artifact.mtimeMs === cached.modifiedAt) {
        if (thumbnail === "keyframe") {
          const preview = await cachedStoryboardVideoThumbnail(cached.assetRoot, cached.path, { modifiedAt: cached.modifiedAt, sha256: cached.sha256 });
          if (request.method === "POST") issueTicket(response, preview);
          else sendArtifact(request, response, next, preview);
        }
        else if (request.method === "POST") issueTicket(response, cached);
        else sendArtifact(request, response, next, cached);
        return;
      }
    } catch {
      // The normal validation path below returns the existing not-found response.
    }
    verifiedArtifacts.delete(cacheKey);
  }

  try {
    const indexedArtifact = await indexedArtifactForPreview({ authorization, episodeId, expectedSha256: expectedSha256 ?? undefined, relativePath, supabasePublishableKey, supabaseUrl });
    if (!indexedArtifact || !isAbsolute(indexedArtifact.assetRoot)) {
      response.statusCode = 404;
      response.end("未找到可预览产物。");
      return;
    }
    if (expectedSha256 && (expectedSha256 !== indexedArtifact.sha256 || !/^[0-9a-f]{64}$/.test(expectedSha256))) {
      response.statusCode = 409;
      response.end("产物修订与索引不一致。");
      return;
    }
    const resolvedRoot = await fs.realpath(indexedArtifact.assetRoot);
    const resolvedArtifact = await fs.realpath(`${indexedArtifact.assetRoot}/${relativePath}`);
    if (!isDescendant(resolvedRoot, resolvedArtifact)) {
      response.statusCode = 403;
      response.end("产物路径超出账号资产目录。");
      return;
    }

    const artifact = await fs.stat(resolvedArtifact);
    if (!artifact.isFile()) {
      response.statusCode = 404;
      response.end("未找到可预览产物。");
      return;
    }
    if (expectedSha256) {
      const actualSha256 = createHash("sha256").update(await fs.readFile(resolvedArtifact)).digest("hex");
      if (actualSha256 !== expectedSha256) {
        response.statusCode = 409;
        response.end("产物内容与冻结修订不一致。");
        return;
      }
    }

    // ponytail: per-process 50-entry/30-second cache; use a shared cache only when preview servers multiply.
    if (verifiedArtifacts.size >= 50) verifiedArtifacts.delete(verifiedArtifacts.keys().next().value!);
    const verified = { assetRoot: resolvedRoot, expiresAt: Date.now() + 30_000, modifiedAt: artifact.mtimeMs, path: resolvedArtifact, sha256: indexedArtifact.sha256, size: artifact.size };
    verifiedArtifacts.set(cacheKey, verified);
    if (thumbnail === "keyframe") {
      const preview = await cachedStoryboardVideoThumbnail(resolvedRoot, resolvedArtifact, { modifiedAt: artifact.mtimeMs, sha256: indexedArtifact.sha256 });
      if (request.method === "POST") issueTicket(response, preview);
      else sendArtifact(request, response, next, preview);
    }
    else if (request.method === "POST") issueTicket(response, verified);
    else sendArtifact(request, response, next, verified);
  } catch {
    response.statusCode = 404;
    response.end("未找到可预览产物。");
  }
  };
}

export function serveLocalEpisodeDirectory(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const episodeId = url.searchParams.get("episode") ?? "";
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    if (!isEpisodeId(episodeId)) {
      response.statusCode = 400;
      response.end("无效的 Episode ID。");
      return;
    }

    try {
      const assetRoot = await assetRootForOwnedEpisode({ authorization, episodeId, supabasePublishableKey, supabaseUrl });
      if (!assetRoot || !isAbsolute(assetRoot)) {
        response.statusCode = 404;
        response.end("未找到可创建目录的 Episode 资产根。");
        return;
      }

      await createLocalEpisodeDirectory(assetRoot, episodeId);

      response.statusCode = 201;
      response.end("本地 Episode 目录已准备就绪。");
    } catch {
      response.statusCode = 403;
      response.end("无法创建本地 Episode 目录。");
    }
  };
}

export function serveOpenLocalEpisodeDirectory(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const episodeId = url.searchParams.get("episode") ?? "";
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    if (!isEpisodeId(episodeId)) {
      response.statusCode = 400;
      response.end("无效的 Episode ID。");
      return;
    }

    try {
      const assetRoot = await assetRootForOwnedEpisode({ authorization, episodeId, supabasePublishableKey, supabaseUrl });
      if (!assetRoot || !isAbsolute(assetRoot)) {
        response.statusCode = 404;
        response.end("未找到可打开的 Episode 资产根。");
        return;
      }

      const episodeDirectory = await createLocalEpisodeDirectory(assetRoot, episodeId);
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
      await execFileAsync(command, [episodeDirectory]);

      response.statusCode = 204;
      response.end();
    } catch {
      response.statusCode = 503;
      response.end("无法打开本地 Episode 目录，请使用页面显示的路径。");
    }
  };
}

export function serveOpenOpenChatCutStudio(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
    const authorization = request.headers.authorization;
    const episodeId = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("episode") ?? "";
    if (!authorization?.startsWith("Bearer ")) { response.statusCode = 401; response.end("需要 Owner 登录会话。"); return; }
    if (!isEpisodeId(episodeId)) { response.statusCode = 400; response.end("无效的 Episode ID。"); return; }
    try {
      const body = await readJsonBody(request);
      if (typeof body.projectRelativePath !== "string") throw new Error("缺少审核工程路径。");
      const assetRoot = await assetRootForOwnedEpisode({ authorization, episodeId, supabasePublishableKey, supabaseUrl });
      if (!assetRoot || !isAbsolute(assetRoot)) { response.statusCode = 404; response.end("未找到可编辑的生产单。"); return; }
      const gate = await studioEntryGateForOwnedEpisode({ assetRoot, authorization, episodeId, projectRelativePath: body.projectRelativePath, supabasePublishableKey, supabaseUrl });
      if (!gate.allowed) { response.statusCode = 409; response.end(gate.message ?? "当前生产单还没有可编辑的审核工程。"); return; }
      const client = createClient(supabaseUrl!, supabasePublishableKey!, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
      let render: NonNullable<WorkerTaskPackage["reviewRender"]> | null = null;
      if (gate.mode === "review_render" && gate.reviewRenderTaskId) {
        const { data: task, error } = await client.from("tasks").select("input_snapshot").eq("id", gate.reviewRenderTaskId).eq("episode_id", episodeId).eq("task_type", "generate_review_render").maybeSingle();
        if (error || !task?.input_snapshot || Array.isArray(task.input_snapshot) || typeof task.input_snapshot !== "object") throw new Error("无法读取生产单的冻结审核输入。");
        render = reviewRenderFromSnapshot(task.input_snapshot as Record<string, unknown>) ?? null;
      } else if (gate.mode === "shot_workbench" && gate.storyboardPackageId) {
        const root = await fs.realpath(assetRoot);
        if (!isSafeRelativeArtifactPath(body.projectRelativePath)) throw new Error("分镜工程路径无效。");
        const storyboardPath = await fs.realpath(resolve(root, body.projectRelativePath));
        if (!isDescendant(root, storyboardPath)) throw new Error("分镜工程超出资产根。");
        const storyboard = JSON.parse(await fs.readFile(storyboardPath, "utf8")) as StoryboardManifest;
        const { data: drafts, error: draftsError } = await client.from("shot_preparation_drafts").select("shot_id, selected_material_revision_id, clip_segments, composition, audio_mode, subtitle_text, subtitles_enabled, tts_text, current_audio_track_id, current_video_artifact_id, current_video_task_id, confirmation_status, preparation_contract, preparation_input_fingerprint").eq("episode_id", episodeId).eq("review_package_id", gate.storyboardPackageId);
        if (draftsError) throw draftsError;
        const materialIds = (drafts ?? []).map((draft) => draft.selected_material_revision_id).filter((id): id is string => typeof id === "string");
        const trackIds = (drafts ?? []).map((draft) => draft.current_audio_track_id).filter((id): id is string => typeof id === "string");
        const materials = materialIds.length ? await client.from("production_material_revisions").select("id, storage_path, sha256").eq("episode_id", episodeId).in("id", materialIds) : { data: [], error: null };
        const tracks = trackIds.length ? await client.from("audio_tracks").select("id, relative_path, sha256, cue_id, start_seconds, duration_seconds").eq("episode_id", episodeId).in("id", trackIds) : { data: [], error: null };
        if (materials.error) throw materials.error;
        if (tracks.error) throw tracks.error;
        render = shotWorkbenchReviewRender(episodeId, body.projectRelativePath, {
          allowedFrames: gate.durationSettings?.allowedFrames ?? 2,
          audioTracks: (tracks.data ?? []).map((track) => ({ id: track.id, cueId: track.cue_id ?? "", relativePath: track.relative_path, sha256: track.sha256, startSeconds: track.start_seconds ?? 0, durationSeconds: track.duration_seconds ?? 0 })),
          drafts: (drafts ?? []).map((draft) => {
            if (draft.confirmation_status !== "confirmed" || !draft.preparation_input_fingerprint) throw new Error(`镜头 ${draft.shot_id} 尚未按当前镜头准备契约确认。`);
            const preparationContract = shotPreparationContractFromSnapshot(draft.preparation_contract);
            return { audioMode: draft.audio_mode, audioTrackId: draft.current_audio_track_id, clipSegments: parseShotWorkbenchClipSegments(draft.clip_segments), composition: preparationContract.composition, confirmationStatus: draft.confirmation_status, inputFingerprint: draft.preparation_input_fingerprint, materialRevisionId: draft.selected_material_revision_id, preparationContract, shotId: draft.shot_id, subtitleText: draft.subtitle_text, subtitlesEnabled: draft.subtitles_enabled, ttsText: draft.tts_text, videoArtifactId: draft.current_video_artifact_id, videoTaskId: draft.current_video_task_id };
          }),
          frameRate: gate.durationSettings?.frameRate ?? 30,
          materials: (materials.data ?? []).map((material) => ({ id: material.id, relativePath: material.storage_path, sha256: material.sha256 })),
          storyboard,
        });
      }
      if (!render || render.projectRelativePath !== body.projectRelativePath) throw new Error("生产单的审核工程与当前版本不一致。");
      const opened = await openOpenChatCutStudio(
        assetRoot,
        episodeId,
        render,
        { nodePath: localWorkerEnvironmentValue("OPENCHATCUT_NODE"), root: localWorkerEnvironmentValue("OPENCHATCUT_ROOT") },
        { replaceWorkspace: body.replaceWorkspace === true },
      );
      response.setHeader("Content-Type", "application/json");
      response.statusCode = opened.replacementWarning ? 200 : 201;
      response.end(JSON.stringify(opened));
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "无法打开 OpenChatCut。");
    }
  };
}

export function serveFreezeOpenChatCutStudio(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
    const authorization = request.headers.authorization;
    const episodeId = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("episode") ?? "";
    if (!authorization?.startsWith("Bearer ")) { response.statusCode = 401; response.end("需要 Owner 登录会话。"); return; }
    if (!isEpisodeId(episodeId)) { response.statusCode = 400; response.end("无效的 Episode ID。"); return; }
    try {
      const body = await readJsonBody(request);
      if (typeof body.sourceProjectRelativePath !== "string" || typeof body.workspaceRelativePath !== "string") throw new Error("缺少 OpenChatCut 工作区路径。");
      const assetRoot = await assetRootForOwnedEpisode({ authorization, episodeId, supabasePublishableKey, supabaseUrl });
      if (!assetRoot || !isAbsolute(assetRoot)) { response.statusCode = 404; response.end("未找到可冻结的生产单工程。"); return; }
      const gate = await studioEntryGateForOwnedEpisode({ assetRoot, authorization, episodeId, projectRelativePath: body.sourceProjectRelativePath, supabasePublishableKey, supabaseUrl });
      if (!gate.allowed) { response.statusCode = 409; response.end(gate.message ?? "当前生产单还没有可冻结的审核工程。"); return; }
      const frozenProject = await freezeOpenChatCutStudio(assetRoot, episodeId, body.workspaceRelativePath);
      response.setHeader("Content-Type", "application/json");
      response.statusCode = 201;
      response.end(JSON.stringify({ frozenProject }));
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "无法冻结 OpenChatCut 工程。");
    }
  };
}

export function serveChooseLocalAssetDirectory(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const accountId = url.searchParams.get("account") ?? "";
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) { response.statusCode = 401; response.end("需要 Owner 登录会话。"); return; }
    if (!isUuid(accountId)) { response.statusCode = 400; response.end("无效的账号 ID。"); return; }
    if (!await accountIsOwned({ accountId, authorization, supabasePublishableKey, supabaseUrl })) { response.statusCode = 403; response.end("没有该账号的 Owner 权限。"); return; }
    if (process.platform !== "darwin") { response.statusCode = 501; response.end("当前本机不支持目录选择器，请直接填写路径。"); return; }
    try {
      const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", "POSIX path of (choose folder with prompt \"选择账号资产目录\")"]);
      const assetRoot = stdout.trim();
      if (!isAbsolute(assetRoot)) throw new Error("无效目录");
      response.setHeader("Content-Type", "application/json");
      response.statusCode = 200;
      response.end(JSON.stringify({ assetRoot }));
    } catch {
      response.statusCode = 503;
      response.end("未选择本地文件夹。");
    }
  };
}

export function serveOpenLocalAssetDirectory(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const accountId = url.searchParams.get("account") ?? "";
    const assetRoot = url.searchParams.get("path")?.trim() ?? "";
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) { response.statusCode = 401; response.end("需要 Owner 登录会话。"); return; }
    if (!isUuid(accountId) || !isAbsolute(assetRoot)) { response.statusCode = 400; response.end("无效的账号或本地目录路径。"); return; }
    if (!await accountIsOwned({ accountId, authorization, supabasePublishableKey, supabaseUrl })) { response.statusCode = 403; response.end("没有该账号的 Owner 权限。"); return; }
    try {
      if (!(await fs.stat(assetRoot)).isDirectory()) throw new Error("不是目录");
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
      await execFileAsync(command, [assetRoot]);
      response.statusCode = 204;
      response.end();
    } catch {
      response.statusCode = 503;
      response.end("无法打开本地文件夹，请检查路径是否存在。");
    }
  };
}

export function serveOpenLocalArtifact(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const episodeId = url.searchParams.get("episode") ?? "";
    const relativePath = url.searchParams.get("path") ?? "";
    const expectedSha256 = url.searchParams.get("sha256") ?? "";
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    if (!isEpisodeId(episodeId)) {
      response.statusCode = 400;
      response.end("无效的 Episode ID。");
      return;
    }
    if (!isSafeRelativeArtifactPath(relativePath)) {
      response.statusCode = 400;
      response.end("无效的本地产物路径。");
      return;
    }
    if (expectedSha256 && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      response.statusCode = 400;
      response.end("无效的产物修订哈希。");
      return;
    }

    try {
      const indexedArtifact = await indexedArtifactForPreview({ authorization, episodeId, expectedSha256: expectedSha256 || undefined, relativePath, supabasePublishableKey, supabaseUrl });
      if (!indexedArtifact || !isAbsolute(indexedArtifact.assetRoot)) {
        response.statusCode = 404;
        response.end("未找到可打开的本地产物。");
        return;
      }
      if (expectedSha256 && expectedSha256 !== indexedArtifact.sha256) {
        response.statusCode = 409;
        response.end("产物修订与索引不一致。");
        return;
      }
      const resolvedRoot = await fs.realpath(indexedArtifact.assetRoot);
      const resolvedArtifact = await fs.realpath(`${indexedArtifact.assetRoot}/${relativePath}`);
      if (!isDescendant(resolvedRoot, resolvedArtifact)) {
        response.statusCode = 403;
        response.end("产物路径超出账号资产目录。");
        return;
      }
      if (!(await fs.stat(resolvedArtifact)).isFile()) {
        response.statusCode = 404;
        response.end("未找到可打开的本地产物。");
        return;
      }
      if (expectedSha256 && createHash("sha256").update(await fs.readFile(resolvedArtifact)).digest("hex") !== expectedSha256) {
        response.statusCode = 409;
        response.end("产物内容与冻结修订不一致。");
        return;
      }
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
      await execFileAsync(command, [resolvedArtifact]);
      response.statusCode = 204;
      response.end();
    } catch {
      response.statusCode = 503;
      response.end("无法打开本地产物，请检查本机文件关联设置。");
    }
  };
}

export function serveEpisodeDeletion(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined, supabaseServiceRoleKey?: string) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "DELETE") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    const episodeId = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("episode") ?? "";
    if (!isEpisodeId(episodeId)) {
      response.statusCode = 400;
      response.end("无效的 Episode ID。");
      return;
    }

    try {
      const body = await readJsonBody(request);
      if (typeof body.confirmation !== "string") throw new Error("缺少删除确认文本。");
      const context = await episodeDeletionContextForOwner({ authorization, episodeId, supabasePublishableKey, supabaseUrl });
      if (!context) {
        response.statusCode = 404;
        response.end("未找到可删除的 Episode。");
        return;
      }
      const expectedConfirmation = context.title.trim() || "DELETE";
      if (body.confirmation !== expectedConfirmation) {
        response.statusCode = 409;
        response.end("删除确认文本不匹配。");
        return;
      }
      if (!context.archivedAt) {
        response.statusCode = 409;
        response.end("请先归档 Episode，再执行永久删除。");
        return;
      }
      if (context.hasRunningTask || context.hasActiveAssetLock) {
        response.statusCode = 409;
        response.end("Episode 仍有运行中的 Worker 任务或资产锁，暂时不能删除。");
        return;
      }
      if (!supabaseUrl || !supabasePublishableKey || !supabaseServiceRoleKey) throw new Error("缺少本机 Supabase service role 配置，无法安全执行永久删除。");

      const local = await stageLocalEpisodeDirectoryForDeletion(context.assetRoot, episodeId);
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } });
      const { data: deletion, error } = await supabase.rpc("delete_episode", { p_actor_id: context.actorId, p_episode_id: episodeId });
      if (error) {
        try {
          if (local.existed) await restoreStagedLocalEpisodeDirectory(context.assetRoot, episodeId);
        } catch (restoreError) {
          response.statusCode = 500;
          response.end(`数据库记录删除失败，且本地目录恢复失败：${restoreError instanceof Error ? restoreError.message : "未知恢复错误"}`);
          return;
        }
        response.statusCode = 500;
        response.end(`数据库记录删除失败，本地 Episode 目录已恢复：${error.message}`);
        return;
      }
      let localRemoved = false;
      try {
        localRemoved = local.existed ? await finalizeStagedLocalEpisodeDirectory(context.assetRoot, episodeId) : false;
      } catch (cleanupError) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          accountId: context.accountId,
          blueprintVersionId: context.blueprintVersionId,
          cleanupPending: true,
          episodeId,
          error: `数据库记录已删除，但本地删除暂存目录失败：${cleanupError instanceof Error ? cleanupError.message : "未知清理错误"}`,
          path: local.path,
        }));
        return;
      }

      response.setHeader("Content-Type", "application/json");
      response.statusCode = 200;
      response.end(JSON.stringify({ database: deletion, episodeId, local: { existed: local.existed, path: local.path, removed: localRemoved } }));
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "无法删除 Episode。");
    }
  };
}

export function serveEpisodeDeletionCleanup(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    try {
      const body = await readJsonBody(request);
      const episodeId = body.episodeId;
      const accountId = body.accountId;
      const blueprintVersionId = body.blueprintVersionId;
      if (typeof episodeId !== "string" || typeof accountId !== "string" || typeof blueprintVersionId !== "string" || !isEpisodeId(episodeId) || !isEpisodeId(accountId) || !isEpisodeId(blueprintVersionId)) throw new Error("删除暂存清理参数无效。");
      const assetRoot = await assetRootForOwnedAccountBlueprint({ authorization, accountId, blueprintVersionId, supabasePublishableKey, supabaseUrl });
      if (!assetRoot) {
        response.statusCode = 404;
        response.end("未找到可清理的账号资产目录。");
        return;
      }
      const removed = await finalizeStagedLocalEpisodeDirectory(assetRoot, episodeId);
      response.setHeader("Content-Type", "application/json");
      response.statusCode = 200;
      response.end(JSON.stringify({ episodeId, removed }));
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "无法清理删除暂存目录。");
    }
  };
}

async function ensureDirectoryWithinRoot(root: string, directory: string): Promise<string> {
  if (!isDescendant(root, directory)) throw new Error("目录超出资产根。");
  try {
    const existing = await fs.lstat(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error("目录不是安全目录。");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    try {
      await fs.mkdir(directory);
    } catch (mkdirError) {
      if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError;
    }
  }
  const resolvedDirectory = await fs.realpath(directory);
  if (!isDescendant(root, resolvedDirectory)) throw new Error("目录超出资产根。");
  return resolvedDirectory;
}

export async function createLocalEpisodeDirectory(assetRoot: string, episodeId: string): Promise<string> {
  const resolvedRoot = await fs.realpath(assetRoot);
  if (isFilesystemRoot(resolvedRoot)) throw new Error("资产根不能是文件系统根目录。");
  const resolvedEpisodesDirectory = await ensureDirectoryWithinRoot(resolvedRoot, resolve(resolvedRoot, "episodes"));
  const episodeDirectory = await ensureDirectoryWithinRoot(resolvedEpisodesDirectory, resolve(resolvedEpisodesDirectory, episodeId));
  await ensureDirectoryWithinRoot(episodeDirectory, resolve(episodeDirectory, "input"));
  await ensureDirectoryWithinRoot(episodeDirectory, resolve(episodeDirectory, "materials"));
  await ensureDirectoryWithinRoot(episodeDirectory, resolve(episodeDirectory, "captions"));
  return episodeDirectory;
}

export async function stageLocalEpisodeDirectoryForDeletion(assetRoot: string, episodeId: string): Promise<{ existed: boolean; path: string; stagingPath: string }> {
  if (!isEpisodeId(episodeId)) throw new Error("无效的 Episode ID。");
  const resolvedRoot = await fs.realpath(assetRoot);
  if (isFilesystemRoot(resolvedRoot)) throw new Error("资产根不能是文件系统根目录。");
  const episodesDirectory = resolve(resolvedRoot, "episodes");
  const episodeDirectory = resolve(episodesDirectory, episodeId);
  let episodesStat;
  try {
    episodesStat = await fs.lstat(episodesDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { existed: false, path: episodeDirectory, stagingPath: resolve(episodesDirectory, ".deletion-staging", episodeId) };
    throw error;
  }
  if (episodesStat.isSymbolicLink() || !episodesStat.isDirectory()) throw new Error("目录不是安全目录。");

  const stagingRoot = await ensureDirectoryWithinRoot(episodesDirectory, resolve(episodesDirectory, ".deletion-staging"));
  const stagingPath = resolve(stagingRoot, episodeId);
  let stagedStat;
  try {
    stagedStat = await fs.lstat(stagingPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    stagedStat = null;
  }
  if (stagedStat && (stagedStat.isSymbolicLink() || !stagedStat.isDirectory())) throw new Error("删除暂存目录不是安全目录。");

  let episodeStat;
  try {
    episodeStat = await fs.lstat(episodeDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (stagedStat) return { existed: true, path: episodeDirectory, stagingPath };
      return { existed: false, path: episodeDirectory, stagingPath };
    }
    throw error;
  }
  if (episodeStat.isSymbolicLink() || !episodeStat.isDirectory()) throw new Error("目录不是安全目录。");
  if (stagedStat) throw new Error("Episode 已有待删除的暂存目录。");

  const resolvedEpisodeDirectory = await fs.realpath(episodeDirectory);
  if (!isDescendant(resolvedRoot, resolvedEpisodeDirectory)) throw new Error("目录超出资产根。");
  await fs.rename(resolvedEpisodeDirectory, stagingPath);
  return { existed: true, path: episodeDirectory, stagingPath };
}

export async function restoreStagedLocalEpisodeDirectory(assetRoot: string, episodeId: string): Promise<void> {
  if (!isEpisodeId(episodeId)) throw new Error("无效的 Episode ID。");
  const resolvedRoot = await fs.realpath(assetRoot);
  const episodesDirectory = resolve(resolvedRoot, "episodes");
  const episodeDirectory = resolve(episodesDirectory, episodeId);
  const stagingPath = resolve(episodesDirectory, ".deletion-staging", episodeId);
  const stagedDirectory = await fs.realpath(stagingPath);
  if (!isDescendant(resolvedRoot, stagedDirectory)) throw new Error("删除暂存目录超出资产根。");
  const existingEpisode = await fs.lstat(episodeDirectory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existingEpisode) throw new Error("原 Episode 目录已存在，无法恢复删除暂存目录。");
  await fs.rename(stagedDirectory, episodeDirectory);
}

export async function finalizeStagedLocalEpisodeDirectory(assetRoot: string, episodeId: string): Promise<boolean> {
  if (!isEpisodeId(episodeId)) throw new Error("无效的 Episode ID。");
  const resolvedRoot = await fs.realpath(assetRoot);
  const stagingPath = resolve(resolvedRoot, "episodes", ".deletion-staging", episodeId);
  let stagedStat;
  try {
    stagedStat = await fs.lstat(stagingPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (stagedStat.isSymbolicLink() || !stagedStat.isDirectory()) throw new Error("删除暂存目录不是安全目录。");
  const resolvedStagingPath = await fs.realpath(stagingPath);
  if (!isDescendant(resolvedRoot, resolvedStagingPath)) throw new Error("删除暂存目录超出资产根。");
  await fs.rm(resolvedStagingPath, { force: false, recursive: true });
  return true;
}

interface MaterialSnapshotInput {
  sourceKind: "directory" | "file" | "paste";
  sourcePath: string;
  logicalName?: string;
  content?: Uint8Array;
}

interface MaterialSnapshot {
  sourcePath: string;
  storagePath: string;
  sha256: string;
  fileSize: number;
}

export async function saveProductionMaterialSnapshot(assetRoot: string, episodeId: string, input: MaterialSnapshotInput): Promise<MaterialSnapshot> {
  if (!isEpisodeId(episodeId)) throw new Error("无效的 Episode ID。");
  if (!isSafeRelativeArtifactPath(input.sourcePath)) throw new Error("输入文件路径无效。");
  if (input.logicalName && !isSafeRelativeArtifactPath(input.logicalName)) throw new Error("材料逻辑名称无效。");
  const episodeDirectory = await createLocalEpisodeDirectory(assetRoot, episodeId);
  let content: Uint8Array;
  if (input.sourceKind === "directory") {
    const inputDirectory = await fs.realpath(join(episodeDirectory, "input"));
    const sourceFile = await fs.realpath(resolve(inputDirectory, input.sourcePath));
    if (!isDescendant(inputDirectory, sourceFile)) throw new Error("输入文件路径无效。");
    const sourceStat = await fs.stat(sourceFile);
    if (!sourceStat.isFile()) throw new Error("输入路径不是文件。");
    content = await fs.readFile(sourceFile);
  } else {
    if (!input.content) throw new Error("文件选择或粘贴导入缺少内容。");
    content = input.content.slice();
  }
  if (content.byteLength > maxProductionMaterialBytes) throw new Error("生产材料超过 100 MB 上限。");

  const sha256 = createHash("sha256").update(content).digest("hex");
  const sourcePath = input.logicalName ?? input.sourcePath;
  const fileName = basename(sourcePath);
  const storagePath = `episodes/${episodeId}/materials/${sha256}-${fileName}`;
  const targetPath = join(assetRoot, storagePath);
  try {
    await fs.writeFile(targetPath, content, { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const existingHash = createHash("sha256").update(await fs.readFile(targetPath)).digest("hex");
    if (existingHash !== sha256) throw new Error("已有材料快照与内容哈希不一致。");
  }
  return { sourcePath, storagePath, sha256, fileSize: content.byteLength };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxEncodedMaterialRequestBytes) throw new Error("编码后的生产材料请求超过 140 MB 上限。");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("生产材料请求无效。");
  return parsed as Record<string, unknown>;
}

async function episodeDeletionContextForOwner(input: { authorization: string; episodeId: string; supabasePublishableKey: string | undefined; supabaseUrl: string | undefined }): Promise<{ accountId: string; actorId: string; archivedAt: string | null; assetRoot: string; blueprintVersionId: string; hasActiveAssetLock: boolean; hasRunningTask: boolean; title: string } | null> {
  if (!input.supabaseUrl || !input.supabasePublishableKey) return null;
  const accessToken = input.authorization.slice("Bearer ".length);
  const supabase = createClient(input.supabaseUrl, input.supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: input.authorization } } });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return null;

  const { data: episode, error: episodeError } = await supabase.from("episodes").select("account_id, archived_at, blueprint_version_id, title").eq("id", input.episodeId).maybeSingle();
  if (episodeError || !episode) return null;
  const { data: membership, error: membershipError } = await supabase.from("account_memberships").select("role").eq("account_id", episode.account_id).eq("user_id", userData.user.id).eq("role", "owner").maybeSingle();
  if (membershipError || !membership) return null;
  const [{ data: runningTasks, error: runningTasksError }, { data: activeLocks, error: activeLocksError }, { data: blueprint, error: blueprintError }] = await Promise.all([
    supabase.from("tasks").select("id").eq("episode_id", input.episodeId).eq("status", "running").limit(1),
    supabase.from("asset_locks").select("resource_key").eq("episode_id", input.episodeId).gt("expires_at", new Date().toISOString()).limit(1),
    supabase.from("account_blueprint_versions").select("policy").eq("id", episode.blueprint_version_id).maybeSingle(),
  ]);
  if (runningTasksError || activeLocksError || blueprintError || !blueprint || !blueprint.policy || Array.isArray(blueprint.policy) || typeof blueprint.policy !== "object") return null;
  const assetRoot = blueprint.policy.asset_root;
  if (typeof assetRoot !== "string" || !assetRoot.trim()) return null;
  return {
    accountId: episode.account_id,
    actorId: userData.user.id,
    archivedAt: typeof episode.archived_at === "string" ? episode.archived_at : null,
    assetRoot: assetRoot.trim(),
    blueprintVersionId: episode.blueprint_version_id,
    hasActiveAssetLock: Boolean(activeLocks?.length),
    hasRunningTask: Boolean(runningTasks?.length),
    title: episode.title,
  };
}

async function assetRootForOwnedAccountBlueprint(input: { accountId: string; authorization: string; blueprintVersionId: string; supabasePublishableKey: string | undefined; supabaseUrl: string | undefined }): Promise<string | null> {
  if (!input.supabaseUrl || !input.supabasePublishableKey) return null;
  const accessToken = input.authorization.slice("Bearer ".length);
  const supabase = createClient(input.supabaseUrl, input.supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: input.authorization } } });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return null;
  const { data: membership, error: membershipError } = await supabase.from("account_memberships").select("role").eq("account_id", input.accountId).eq("user_id", userData.user.id).eq("role", "owner").maybeSingle();
  if (membershipError || !membership) return null;
  const { data: blueprint, error: blueprintError } = await supabase.from("account_blueprint_versions").select("policy").eq("account_id", input.accountId).eq("id", input.blueprintVersionId).maybeSingle();
  if (blueprintError || !blueprint || !blueprint.policy || Array.isArray(blueprint.policy) || typeof blueprint.policy !== "object") return null;
  const assetRoot = blueprint.policy.asset_root;
  return typeof assetRoot === "string" && assetRoot.trim() ? assetRoot.trim() : null;
}

function localWorkerServiceRoleKey(): string | undefined {
  try {
    const workerEnv = readFileSync(resolve("n8n", "worker.env.local"), "utf8");
    return workerEnv.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function localWorkerEnvironmentValue(name: string): string | undefined {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess.replace(/^['"]|['"]$/g, "");
  try {
    const workerEnv = readFileSync(resolve("n8n", "worker.env.local"), "utf8");
    const value = workerEnv.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
    return value?.replace(/^['"]|['"]$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

function readN8nExecutionEvidence(databasePath: string): N8nExecutionEvidence | null {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const columns = `select e.id, e."startedAt" as startedAt, e.status, w.name as workflowName, d.data
      from execution_entity e
      join workflow_entity w on w.id = e."workflowId"
      left join execution_data d on d."executionId" = e.id`;
    const schedule = database.prepare(`${columns} where w.name = ? order by e."startedAt" desc, e.id desc limit 1`).all("Loop Control — 任务派发");
    const workerDispatch = database.prepare(`${columns} where w.name = ? and e.status = 'success' and d.data like ? order by e."startedAt" desc, e.id desc limit 1`).all("Loop Control — 任务派发", '%\\"workers\\":[{%');
    const notification = database.prepare(`${columns} where w.name in (?, ?) order by e."startedAt" desc, e.id desc limit 1`).all("Loop Control — 审核提醒", "Loop Control — 状态变更提醒");
    return summarizeN8nExecutions([...schedule, ...workerDispatch, ...notification] as unknown as N8nExecutionEvidenceRow[]);
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function safeStatusDetail(error: unknown): string {
  const source = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
  return source
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\bbearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/(authorization|bearer|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[已隐藏]")
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://[已隐藏]@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function dependencyStatus(name: string, command: string, args: string[]): Promise<{ detail: string; name: string; state: "healthy" | "offline" }> {
  try {
    const result = await execFileAsync(command, args);
    return { detail: result.stdout.split("\n")[0] || "可调用", name, state: "healthy" };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : "无法调用", name, state: "offline" };
  }
}

async function n8nHealth(port: string): Promise<boolean> {
  if (!/^\d+$/.test(port)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function runProbeCommand(command: string, argumentsList: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, argumentsList, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs) : undefined;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { if (timeout) clearTimeout(timeout); rejectCommand(error); });
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolveCommand({ stdout, stderr });
      else if (timedOut) rejectCommand(new Error(`${command} 执行超时。`));
      else rejectCommand(new Error(stderr.trim() || `${command} exited with status ${code ?? "unknown"}.`));
    });
  });
}

export function serveSystemStatus(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  const expensiveProbeTtlMs = 5 * 60_000;
  const migrationCache = new ExpiringProbeCache<{ detail: string; state: "consistent" | "inconsistent" | "unknown" }>(expensiveProbeTtlMs);
  const codexModelCache = new ExpiringProbeCache<Awaited<ReturnType<typeof probeCodexModel>>>(expensiveProbeTtlMs);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    if (!supabaseUrl || !supabasePublishableKey) {
      response.statusCode = 503;
      response.end("Supabase 本地客户端未配置。");
      return;
    }
    try {
      const accessToken = authorization.slice("Bearer ".length);
      const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
      const { data, error } = await client.auth.getUser(accessToken);
      if (error || !data.user) {
        response.statusCode = 401;
        response.end("Owner 登录会话无效。");
        return;
      }

      const runtimeDirectory = resolve("n8n", "runtime", ".n8n");
      const runtimeExists = await fs.stat(runtimeDirectory).then((stats) => stats.isDirectory()).catch(() => false);
      const n8nPort = localWorkerEnvironmentValue("N8N_PORT") ?? "5678";
      const n8nRunning = await n8nHealth(n8nPort);
      const n8nEvidence = readN8nExecutionEvidence(join(runtimeDirectory, "database.sqlite"));
      const mediaRoot = localWorkerEnvironmentValue("MEDIA_LIBRARY_MOUNT_PATH");
      const mediaExists = mediaRoot ? await fs.stat(mediaRoot).then((stats) => stats.isDirectory()).catch(() => false) : false;
      const localDependencies = await Promise.all([
        dependencyStatus("Codex CLI", "codex", ["--version"]),
        dependencyStatus("ffmpeg", "ffmpeg", ["-version"]),
        dependencyStatus("OpenChatCut", localWorkerEnvironmentValue("OPENCHATCUT_NODE") || process.execPath, ["scripts/openchatcut-render.mjs", "--version"]),
      ]);
      const migration = migrationCache.read("remote-history", { detail: "Supabase 迁移正在后台探测；当前无法确认。", state: "unknown" }, async () => {
        try {
          const result = await runProbeCommand(process.execPath, ["scripts/supabase-migrations.mjs", "--status-json"], 65_000);
          const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as { detail?: unknown; state?: unknown };
          if (typeof payload.detail === "string" && ["consistent", "inconsistent", "unknown"].includes(String(payload.state))) return payload as { detail: string; state: "consistent" | "inconsistent" | "unknown" };
          return { detail: "无法确认 Supabase 迁移：探测输出无效。", state: "unknown" };
        } catch (error) {
          return { detail: `无法确认 Supabase 迁移：${safeStatusDetail(error)}`, state: "unknown" };
        }
      });
      const [ownerMembershipResult, activeBlueprintResult] = await Promise.all([
        (async () => {
          try { return await client.from("account_memberships").select("account_id").eq("user_id", data.user.id).eq("role", "owner").limit(1); }
          catch (error) { return { data: null, error }; }
        })(),
        (async () => {
          try { return await client.from("account_blueprint_versions").select("policy").eq("is_active", true).is("archived_at", null); }
          catch (error) { return { data: null, error }; }
        })(),
      ]);
      const { data: activeBlueprints, error: activeBlueprintsError } = activeBlueprintResult;
      const supabase = supabaseControlDataEvidence({
        activeBlueprintsReadable: !activeBlueprintsError,
        hasOwnerMembership: Boolean(ownerMembershipResult.data?.length),
        ownerMembershipsReadable: !ownerMembershipResult.error,
      });
      const codexModels = activeBlueprintsError ? [] : [...new Set((activeBlueprints ?? []).flatMap(({ policy }) => runtimeCapabilitiesFromBlueprintPolicy(policy, undefined).filter((capability) => capability.provider === "codex" && capability.model).map((capability) => capability.model as string)))];
      const codexCliAvailable = localDependencies[0]?.state === "healthy";
      const codexModelDependencies = activeBlueprintsError
        ? [{ detail: `无法读取当前激活蓝图的 Codex 模型：${safeStatusDetail(activeBlueprintsError)}`, name: "Codex 模型", state: "unknown" as const }]
        : codexModels.length === 0
          ? [{ detail: "当前激活蓝图未配置 Codex 模型。", name: "Codex 模型", state: "unknown" as const }]
          : codexModels.map((model) => {
              if (!codexCliAvailable) return { detail: `模型 ${model} 未探测：Codex CLI 不可用。`, name: `Codex 模型 · ${model}`, state: "offline" as const };
              const probe = codexModelCache.read(model, {
                connection: { available: false, status: "retryable", detail: "Codex 模型服务正在后台探测。" },
                modelPermission: { available: false, status: "retryable", detail: `模型 ${model} 权限正在后台探测。` },
              }, () => probeCodexModel(model, (command, argumentsList, options) => runProbeCommand(command, argumentsList, options?.timeoutMs), tmpdir()));
              return { detail: probe.modelPermission.detail, name: `Codex 模型 · ${model}`, state: probe.modelPermission.available ? "healthy" as const : probe.modelPermission.status === "retryable" ? "unknown" as const : "attention" as const };
            });
      const notificationFailed = n8nEvidence?.lastNotification?.state === "failure";
      const n8nDetail = !runtimeExists
        ? "未发现本地 n8n 运行时目录。"
        : !n8nRunning
          ? `健康端点无响应：127.0.0.1:${n8nPort}；历史执行记录不代表当前在线。`
          : !n8nEvidence
            ? `健康端点在线：127.0.0.1:${n8nPort}；执行数据库无法读取，调度与通知状态待确认。`
          : `${n8nEvidence?.lastScheduleCheckAt ? "已读取最近调度执行" : "尚无调度执行记录"}；${n8nEvidence?.lastNotification ? `通知链最近${notificationFailed ? "失败" : "成功"}（${n8nEvidence.lastNotification.workflowName}）` : "通知链尚无执行记录"}。`;
      const dependencies = [
        ...localDependencies,
        { detail: migration.detail, name: "Supabase 迁移", state: migration.state === "consistent" ? "healthy" as const : migration.state === "inconsistent" ? "attention" as const : "unknown" as const },
        ...codexModelDependencies,
      ];
      const report = {
        dependencies,
        mediaLibrary: { detail: mediaRoot ? (mediaExists ? `已挂载：${mediaRoot}` : `未找到挂载目录：${mediaRoot}`) : "未配置 MEDIA_LIBRARY_MOUNT_PATH。", state: mediaExists ? "healthy" : "offline" },
        n8n: {
          detail: n8nDetail,
          lastDispatchAt: n8nEvidence?.lastWorkerDispatchAt ?? null,
          lastEventAt: n8nEvidence?.lastScheduleCheckAt ?? null,
          lastHealthCheckAt: n8nRunning ? new Date().toISOString() : null,
          lastNotification: n8nEvidence?.lastNotification ?? null,
          lastRunAt: n8nEvidence?.lastWorkerDispatchAt ?? null,
          lastScheduleCheckAt: n8nEvidence?.lastScheduleCheckAt ?? null,
          lastWorkerDispatchAt: n8nEvidence?.lastWorkerDispatchAt ?? null,
          state: n8nRunning ? (!n8nEvidence ? "unknown" : notificationFailed ? "attention" : "healthy") : "offline",
        },
        observedAt: new Date().toISOString(),
        supabase,
      };
      response.setHeader("Content-Type", "application/json");
      response.statusCode = 200;
      response.end(JSON.stringify(report));
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "无法读取系统状态。");
    }
  };
}

export function serveGoldenProductionTest(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) { response.statusCode = 401; response.end("需要 Owner 登录会话。"); return; }
    if (!supabaseUrl || !supabasePublishableKey) { response.statusCode = 503; response.end("Supabase 本地客户端未配置。"); return; }
    const accessToken = authorization.slice("Bearer ".length);
    const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
    const { data, error } = await client.auth.getUser(accessToken);
    if (error || !data.user) { response.statusCode = 401; response.end("Owner 登录会话无效。"); return; }
    try {
      const result = await runProbeCommand(join(process.cwd(), "n8n", "run-orchestrator.sh"), ["health"], 60_000);
      const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as { passed?: unknown; checks?: Array<{ detail?: unknown; name?: unknown; passed?: unknown }> };
      const checks = Array.isArray(payload.checks) ? payload.checks.map((check) => ({ detail: typeof check.detail === "string" ? check.detail : check.passed === true ? "通过" : "未通过", name: typeof check.name === "string" ? check.name : "健康检查", passed: check.passed === true })) : [];
      response.setHeader("Content-Type", "application/json"); response.statusCode = 200;
      response.end(JSON.stringify({ checks, observedAt: new Date().toISOString(), passed: payload.passed === true }));
    } catch (cause) {
      response.setHeader("Content-Type", "application/json"); response.statusCode = 500;
      response.end(JSON.stringify({ error: cause instanceof Error ? cause.message : "黄金生产链测试失败。" }));
    }
  };
}

export function serveWorkerPreflight(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "GET" && request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    const episodeId = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("episode") ?? "";
    if (!isEpisodeId(episodeId)) {
      response.statusCode = 400;
      response.end("无效的 Episode ID。");
      return;
    }
    if (!supabaseUrl || !supabasePublishableKey) {
      response.statusCode = 503;
      response.end("Supabase 本地客户端未配置。");
      return;
    }
    try {
      const accessToken = authorization.slice("Bearer ".length);
      const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
      const { data: userData, error: userError } = await client.auth.getUser(accessToken);
      if (userError || !userData.user) {
        response.statusCode = 401;
        response.end("Owner 登录会话无效。");
        return;
      }

      const { data: episode, error: episodeError } = await client.from("episodes").select("account_id, blueprint_version_id, series_version_id").eq("id", episodeId).maybeSingle();
      if (episodeError) throw episodeError;
      if (!episode) {
        response.statusCode = 404;
        response.end("未找到当前 Episode。");
        return;
      }
      const { data: membership, error: membershipError } = await client.from("account_memberships").select("role").eq("account_id", episode.account_id).eq("user_id", userData.user.id).eq("role", "owner").maybeSingle();
      if (membershipError) throw membershipError;
      if (!membership) {
        response.statusCode = 403;
        response.end("Owner 权限不足。");
        return;
      }
      let seriesRules: unknown;
      if (episode.series_version_id) {
        const { data: seriesVersion, error: seriesVersionError } = await client.from("series_versions").select("rules").eq("id", episode.series_version_id).eq("account_id", episode.account_id).maybeSingle();
        if (seriesVersionError) throw seriesVersionError;
        seriesRules = seriesVersion?.rules;
      }
      const { data: blueprint, error: blueprintError } = await client.from("account_blueprint_versions").select("policy").eq("id", episode.blueprint_version_id).eq("account_id", episode.account_id).maybeSingle();
      if (blueprintError) throw blueprintError;
      if (!blueprint) {
        response.statusCode = 404;
        response.end("未找到当前 Episode 的蓝图快照。");
        return;
      }

      const { data: tasks, error: tasksError } = await client.from("tasks").select("task_type, provider, status, input_snapshot").eq("episode_id", episodeId);
      if (tasksError) throw tasksError;
      const report = await runtimePreflightForPolicy(blueprint.policy, seriesRules, requiredMediaCapabilitiesFromTasks(tasks), true, episode.account_id);
      if (request.method === "POST") {
        response.setHeader("Content-Type", "application/json");
        if (report.checks.some((check) => check.status !== "passed")) {
          response.statusCode = 409;
          response.end(JSON.stringify({ preflight: report }));
          return;
        }
        const workerServiceRoleKey = localWorkerServiceRoleKey();
        if (!workerServiceRoleKey) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: "本地 Worker 服务角色密钥未配置，无法记录运行态检查。", preflight: report }));
          return;
        }
        const adminClient = createClient(supabaseUrl, workerServiceRoleKey, { auth: { persistSession: false } });
        const { error: recordPreflightError } = await adminClient.rpc("record_episode_worker_preflight", { p_episode_id: episodeId, p_owner_id: userData.user.id });
        if (recordPreflightError) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: recordPreflightError.message, preflight: report }));
          return;
        }
        const { data: startedEpisode, error: startError } = await client.rpc("start_episode_production", { p_episode_id: episodeId });
        if (startError) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: startError.message, preflight: report }));
          return;
        }
        const dispatchStatus = beginEpisodeDispatch(episodeId);
        response.statusCode = 200;
        response.end(JSON.stringify({ dispatch: { status: dispatchStatus }, episode: startedEpisode, preflight: report }));
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.statusCode = 200;
      response.end(JSON.stringify(report));
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "无法读取 Worker 运行态检查。");
    }
  };
}

export function serveEpisodePreflight(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    if (!supabaseUrl || !supabasePublishableKey) {
      response.statusCode = 503;
      response.end("Supabase 本地客户端未配置。");
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      response.statusCode = 400;
      response.end("创建前检查参数无效。");
      return;
    }
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const blueprintVersionId = typeof body.blueprintVersionId === "string" ? body.blueprintVersionId : "";
    const episodeIdValue = body.episodeId;
    const episodeId = episodeIdValue === undefined ? null : typeof episodeIdValue === "string" ? episodeIdValue : "";
    const policy = body.policy;
    const seriesVersionValue = body.seriesVersionId;
    const seriesVersionId = seriesVersionValue === null || seriesVersionValue === undefined ? null : typeof seriesVersionValue === "string" ? seriesVersionValue : "";
    if (!isUuid(accountId) || !isUuid(blueprintVersionId) || (episodeId !== null && !isUuid(episodeId)) || (seriesVersionId !== null && !isUuid(seriesVersionId)) || (policy !== undefined && (!policy || Array.isArray(policy) || typeof policy !== "object"))) {
      response.statusCode = 400;
      response.end("创建前检查参数无效。");
      return;
    }

    try {
      const accessToken = authorization.slice("Bearer ".length);
      const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
      const { data: userData, error: userError } = await client.auth.getUser(accessToken);
      if (userError || !userData.user) {
        response.statusCode = 401;
        response.end("Owner 登录会话无效。");
        return;
      }

      const { data: membership, error: membershipError } = await client.from("account_memberships").select("role").eq("account_id", accountId).eq("user_id", userData.user.id).eq("role", "owner").maybeSingle();
      if (membershipError) throw membershipError;
      if (!membership) {
        response.statusCode = 403;
        response.end("Owner 权限不足。");
        return;
      }
      const { data: account, error: accountError } = await client.from("accounts").select("current_blueprint_version_id").eq("id", accountId).maybeSingle();
      if (accountError) throw accountError;
      if (!account) {
        response.statusCode = 404;
        response.end("未找到当前账号。");
        return;
      }
      if (account.current_blueprint_version_id !== blueprintVersionId) {
        response.statusCode = 409;
        response.end("所选蓝图已不是当前激活版本，请刷新后重试。");
        return;
      }

      let episodeSeriesVersionId = seriesVersionId;
      if (episodeId) {
        const { data: episode, error: episodeError } = await client.from("episodes").select("account_id, series_version_id").eq("id", episodeId).maybeSingle();
        if (episodeError) throw episodeError;
        if (!episode) {
          response.statusCode = 404;
          response.end("未找到当前生产单。");
          return;
        }
        if (episode.account_id !== accountId) {
          response.statusCode = 403;
          response.end("生产单不属于当前账号。");
          return;
        }
        episodeSeriesVersionId = episode.series_version_id;
      }

      const { data: blueprint, error: blueprintError } = await client.from("account_blueprint_versions").select("policy, is_active").eq("id", blueprintVersionId).eq("account_id", accountId).maybeSingle();
      if (blueprintError) throw blueprintError;
      if (!blueprint) {
        response.statusCode = 404;
        response.end("未找到当前账号蓝图。");
        return;
      }
      if (!blueprint.is_active) {
        response.statusCode = 409;
        response.end("所选蓝图已停用，请刷新后重试。");
        return;
      }

      let seriesRules: unknown;
      if (episodeSeriesVersionId) {
        const { data: seriesVersion, error: seriesVersionError } = await client.from("series_versions").select("rules").eq("id", episodeSeriesVersionId).eq("account_id", accountId).maybeSingle();
        if (seriesVersionError) throw seriesVersionError;
        if (!seriesVersion) {
          response.statusCode = 400;
          response.end(episodeId ? "当前生产单的系列版本不属于当前账号。" : "所选系列版本不属于当前账号。");
          return;
        }
        seriesRules = seriesVersion.rules;
      }

      let requiredMediaCapabilities: string[] | undefined;
      if (episodeId) {
        const { data: tasks, error: tasksError } = await client.from("tasks").select("task_type, provider, status, input_snapshot").eq("episode_id", episodeId);
        if (tasksError) throw tasksError;
        requiredMediaCapabilities = requiredMediaCapabilitiesFromTasks(tasks);
      }
      const report = await runtimePreflightForPolicy(policy ?? blueprint.policy, seriesRules, requiredMediaCapabilities, Boolean(episodeId), accountId);
      response.setHeader("Content-Type", "application/json");
      if (report.checks.some((check) => check.status !== "passed")) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: episodeId ? "修复前真实运行态检查未通过，当前生产单仍保持阻塞。" : "生产前可生产性检查未通过，尚未创建生产单。", preflight: report }));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify({ preflight: report }));
    } catch (error) {
      response.setHeader("Content-Type", "application/json");
      if (isTransientPreflightError(error)) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "生产前检查暂时失败，请重试。", preflight: retryablePreflight(error) }));
        return;
      }
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "无法完成生产前检查。" }));
    }
  };
}

export function serveExternalConnectionTest(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined, serviceRoleKey = localWorkerServiceRoleKey()) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    if (!supabaseUrl || !supabasePublishableKey || !serviceRoleKey) {
      response.statusCode = 503;
      response.end("连接测试 Worker 未配置。");
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      response.statusCode = 400;
      response.end("连接测试请求无效。");
      return;
    }
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
    if (!isUuid(connectionId)) {
      response.statusCode = 400;
      response.end("连接 ID 无效。");
      return;
    }

    try {
      const accessToken = authorization.slice("Bearer ".length);
      const ownerClient = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
      const { data: userData, error: userError } = await ownerClient.auth.getUser(accessToken);
      if (userError || !userData.user) {
        response.statusCode = 401;
        response.end("Owner 登录会话无效。");
        return;
      }
      const { data: connection, error: connectionError } = await ownerClient.from("external_connections").select("id, provider, adapter, name, status, last_verification_detail, last_verified_at, created_by, created_at, current_version_id").eq("id", connectionId).eq("created_by", userData.user.id).maybeSingle();
      if (connectionError) throw connectionError;
      if (!connection) {
        response.statusCode = 404;
        response.end("未找到可测试的外部连接。");
        return;
      }

      const serviceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
      const { data: secret, error: secretError } = await serviceClient.rpc("resolve_external_connection_secret", { p_connection_id: connection.current_version_id });
      if (secretError) throw secretError;
      const probe = typeof secret === "string" && secret.trim()
        ? await probeProviderConnection(connection.provider, secret.trim(), fetch)
        : { connection: { available: false, status: "unavailable" as const, detail: "连接秘密不可用。" } };
      const status = probe.credentialValidity?.status === "unavailable" ? "invalid" : !probe.connection.available ? (probe.connection.status === "retryable" ? "retryable" : "invalid") : "verified";
      const detail = redactConnectionSecret(probe.credentialValidity?.detail ?? probe.connection.detail, typeof secret === "string" ? secret : "");
      const { data: updatedConnection, error: recordError } = await serviceClient.rpc("record_external_connection_verification", { p_connection_id: connection.current_version_id, p_status: status, p_detail: detail });
      if (recordError) throw recordError;
      response.setHeader("Content-Type", "application/json");
      response.statusCode = 200;
      response.end(JSON.stringify({ connection: updatedConnection ?? { ...connection, status, last_verification_detail: detail }, verification: { status, detail } }));
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "无法完成连接测试。");
    }
  };
}

export function servePublishPreparation(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined, serviceRoleKey = localWorkerServiceRoleKey()) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) { response.statusCode = 401; response.end("需要 Owner 登录会话。"); return; }
    if (!supabaseUrl || !supabasePublishableKey || !serviceRoleKey) { response.statusCode = 503; response.end("发布准备 Worker 未配置。"); return; }
    try {
      const body = await readJsonBody(request);
      const episodeId = typeof body.episodeId === "string" ? body.episodeId : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const description = typeof body.description === "string" ? body.description.trim() : "";
      const tags = Array.isArray(body.tags) ? body.tags.map((tag) => typeof tag === "string" ? tag.trim() : "").filter(Boolean) : [];
      const coverBase64 = typeof body.coverBase64 === "string" ? body.coverBase64 : "";
      if (!isEpisodeId(episodeId) || !title || title.length > 200 || description.length > 5000 || tags.length > 20 || tags.some((tag) => tag.length > 50)) throw new Error("发布标题、简介或标签无效。");
      if (!coverBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(coverBase64)) throw new Error("请选择有效的封面。");
      const cover = Buffer.from(coverBase64, "base64");
      const coverExtension = coverImageExtension(cover);
      if (cover.byteLength > 20 * 1024 * 1024 || !coverExtension) throw new Error("封面必须是 20 MB 以内的 JPG、PNG 或 WebP 文件。");
      const assetRoot = await assetRootForOwnedEpisode({ authorization, episodeId, supabasePublishableKey, supabaseUrl });
      if (!assetRoot) { response.statusCode = 403; response.end("没有该生产单的 Owner 权限。"); return; }
      const mediaLibraryMountPath = localWorkerEnvironmentValue("MEDIA_LIBRARY_MOUNT_PATH");
      const minimumFreeBytes = Number(localWorkerEnvironmentValue("MEDIA_LIBRARY_MIN_FREE_BYTES"));
      if (!mediaLibraryMountPath || !Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) throw new Error("本机媒体库配置无效。");
      const serviceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
      const context = await loadPublishContext({ allowedStages: ["qc_passed"], episodeId, mediaLibraryMountPath, mediaLibraryMinimumFreeBytes: minimumFreeBytes, supabase: serviceClient });
      if (context.artifacts.some((artifact) => artifact.artifactType === "publish_package")) throw new Error("发布包已经固定，不能覆盖发布输入。");
      const coverPath = coverInputPath(episodeId, coverExtension);
      const metadataPath = `episodes/${episodeId}/publish-input/metadata-v1.json`;
      const metadata = Buffer.from(`${JSON.stringify({ title, description, tags }, null, 2)}\n`);
      const publishInputs = [{ artifactType: "cover", relativePath: coverPath, bytes: cover }, { artifactType: "metadata", relativePath: metadataPath, bytes: metadata }];
      for (const artifact of publishInputs) {
        const existing = context.artifacts.find((candidate) => candidate.artifactType === artifact.artifactType);
        const sha256 = createHash("sha256").update(artifact.bytes).digest("hex");
        if (existing && (existing.relativePath !== artifact.relativePath || existing.sha256 !== sha256 || existing.fileSize !== artifact.bytes.byteLength)) throw new Error(`${artifact.artifactType === "cover" ? "封面" : "发布元数据"}已经固定，不能覆盖。`);
      }
      for (const artifact of publishInputs) {
        await writeSafeAssetFile(assetRoot, artifact.relativePath, artifact.bytes);
        const { error } = await serviceClient.rpc("record_publish_input", { p_episode_id: episodeId, p_artifact_type: artifact.artifactType, p_relative_path: artifact.relativePath, p_sha256: createHash("sha256").update(artifact.bytes).digest("hex"), p_file_size: artifact.bytes.byteLength });
        if (error) throw new Error(`无法登记${artifact.artifactType === "cover" ? "封面" : "发布元数据"}：${error.message}`);
      }
      const registered = await loadPublishContext({ allowedStages: ["qc_passed"], episodeId, mediaLibraryMountPath, mediaLibraryMinimumFreeBytes: minimumFreeBytes, supabase: serviceClient });
      const publishPackage = await createPublishPackage({ assetRoot, episodeId, artifacts: registered.artifacts });
      const { error: packageError } = await serviceClient.rpc("record_publish_package", { p_episode_id: episodeId, p_relative_path: publishPackage.relativePath, p_sha256: publishPackage.sha256, p_file_size: publishPackage.fileSize });
      if (packageError) throw new Error(`无法登记发布包：${packageError.message}`);
      await verifyPublishPackage({ assetRoot, episodeId, publishPackage });
      const { error: verificationError } = await serviceClient.rpc("record_publish_package_verification", { p_episode_id: episodeId, p_sha256: publishPackage.sha256, p_file_size: publishPackage.fileSize });
      if (verificationError) throw new Error(`无法登记发布包校验：${verificationError.message}`);
      response.setHeader("Content-Type", "application/json");
      response.statusCode = 201;
      response.end(JSON.stringify({ episodeId, publishPackage, status: "verified" }));
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "无法准备发布包。");
    }
  };
}

function redactConnectionSecret(detail: string, secret: string): string {
  return secret ? detail.split(secret).join("[已隐藏]") : detail;
}

export async function runtimePreflightForPolicy(policy: unknown, seriesRules: unknown, requiredMediaCapabilities?: readonly string[], hasExistingEpisode = false, accountId?: string) {
  const capabilities = runtimeCapabilitiesFromBlueprintPolicy(policy, seriesRules, requiredMediaCapabilities);
  const commandNames = [...new Set(capabilities.map((capability) => capability.command).filter((command): command is string => Boolean(command)))];
  const credentialNames = [...new Set(capabilities.map((capability) => capability.credential).filter((credential): credential is string => Boolean(credential)))];
  const credentials = Object.fromEntries(credentialNames.map((credential) => [credential, Boolean(localWorkerEnvironmentValue(credential))]));
  const referenceCapabilities = capabilities.filter((capability) => capability.credentialRef);
  const referenceEntriesPromise = Promise.all(referenceCapabilities.map(async (capability) => [capability.credentialRef!, await localWorkerSecretForCapability(capability, accountId)] as const));
  const commandEntriesPromise = Promise.all(commandNames.map(async (command) => {
    const invocation = runtimeCommandInvocation(command, runtimeCommandArguments(command), { openChatCutNode: localWorkerEnvironmentValue("OPENCHATCUT_NODE") });
    return [command, await dependencyStatus(command, invocation.command, invocation.argumentsList)] as const;
  }));
  const providerEntriesPromise = Promise.all([...new Set(capabilities.filter((capability) => capability.credential || capability.credentialRef).map((capability) => capability.provider))].map(async (provider) => {
    const capability = capabilities.find((candidate) => candidate.provider === provider);
    const credential = capability?.credential;
    const apiKey = capability?.credentialRef && isUuid(capability.credentialRef)
      ? await localWorkerSecretForCapability(capability, accountId)
      : capability?.credential ? localWorkerEnvironmentValue(capability.credential) : undefined;
    if (!apiKey) return null;
    return { provider, credential: credential ?? capability?.credentialRef, probe: await probeProviderConnection(provider, apiKey) };
  }));
  const assetRootPromise = workerMediaLibraryStatus(policy, hasExistingEpisode);
  const commandEntries = await commandEntriesPromise;
  const commands = Object.fromEntries(commandEntries.map(([command, status]) => [command, { available: status.state === "healthy", detail: status.detail }]));
  const localAdapters = localAdapterReadinessFromCommands(capabilities, commands);
  const modelEntries = await Promise.all([...new Set(capabilities.filter((capability) => capability.provider === "codex" && capability.model && commands.codex?.available).map((capability) => capability.model as string))].map(async (model) => {
    const probe = await probeCodexModel(model, (command, argumentsList, options) => runProbeCommand(command, argumentsList, options?.timeoutMs), tmpdir());
    return [model, probe] as const;
  }));
  const [providerEntries, referenceEntries, assetRoot] = await Promise.all([providerEntriesPromise, referenceEntriesPromise, assetRootPromise]);
  const modelPermissions = Object.fromEntries(modelEntries.map(([model, probe]) => [model, probe.modelPermission]));
  const connections = Object.fromEntries(providerEntries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).map((entry) => [entry.provider, entry.probe.connection]));
  const credentialValidity = Object.fromEntries(providerEntries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry?.probe.credentialValidity)).map((entry) => [entry.credential, entry.probe.credentialValidity]));
  const connectionReferences = Object.fromEntries(referenceEntries.map(([reference, secret]) => [reference, secret ? { available: true, detail: "外部连接引用已解析。" } : { available: false, detail: "外部连接引用不存在或尚未验证。" }]));
  return createRuntimePreflight(capabilities, {
    commands,
    ...(Object.keys(localAdapters).length ? { localAdapters } : {}),
    credentials: { ...credentials, ...Object.fromEntries(referenceEntries.map(([reference, secret]) => [reference, Boolean(secret)])) },
    ...(Object.keys(connectionReferences).length ? { connectionReferences } : {}),
    ...(Object.keys(modelPermissions).length ? { modelPermissions } : {}),
    ...(Object.keys(connections).length ? { connections } : {}),
    ...(Object.keys(credentialValidity).length ? { credentialValidity } : {}),
    ...(hasExistingEpisode ? { assetRoot } : { mediaLibrary: assetRoot }),
  });
}

async function localWorkerSecretForCapability(capability: { credential?: string; credentialRef?: string; provider: string }, accountId?: string): Promise<string | undefined> {
  const reference = capability.credentialRef;
  if (reference && isUuid(reference)) {
    if (!accountId) return undefined;
    const key = localWorkerServiceRoleKey();
    const url = localWorkerEnvironmentValue("SUPABASE_URL") ?? process.env.VITE_SUPABASE_URL;
    if (!key || !url) return undefined;
    const client = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await client.rpc("resolve_external_connection_secret", { p_account_id: accountId, p_connection_id: reference });
    if (error || typeof data !== "string") return undefined;
    return data.trim() || undefined;
  }
  if (capability.provider === "pexels") return undefined;
  return capability.credential ? localWorkerEnvironmentValue(capability.credential) : undefined;
}

function isTransientPreflightError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /fetch failed|network|timeout|timed out|econnreset|econnrefused|etimedout|502|503|504/.test(detail);
}

function retryablePreflight(error: unknown) {
  return {
    version: workerPreflightVersion,
    checks: [{ capability: "worker_runtime", check: "connection", phase: "preflight" as const, status: "retryable" as const, reason: error instanceof Error ? error.message : "Worker 或 Supabase 连接暂时失败。", action: "retry" as const, scope: "worker" as const }],
  };
}

async function workerMediaLibraryStatus(policy: unknown, requireEpisodesDirectory = false): Promise<{ available: boolean; detail: string } | undefined> {
  const assetRoot = policy && typeof policy === "object" && !Array.isArray(policy) && typeof (policy as Record<string, unknown>).asset_root === "string" ? ((policy as Record<string, unknown>).asset_root as string).trim() : "";
  if (!assetRoot) return { available: false, detail: "蓝图未配置 asset_root。" };
  if (!isAbsolute(assetRoot)) return { available: false, detail: "蓝图 asset_root 必须使用绝对路径。" };
  const mountPath = localWorkerEnvironmentValue("MEDIA_LIBRARY_MOUNT_PATH");
  if (!mountPath) return { available: false, detail: "未配置 MEDIA_LIBRARY_MOUNT_PATH。" };
  const minimumFreeBytesValue = localWorkerEnvironmentValue("MEDIA_LIBRARY_MIN_FREE_BYTES");
  if (!minimumFreeBytesValue || !/^\d+$/.test(minimumFreeBytesValue) || !Number.isSafeInteger(Number(minimumFreeBytesValue))) return { available: false, detail: "MEDIA_LIBRARY_MIN_FREE_BYTES 未配置为非负整数。" };
  try {
    const status = await verifyMediaLibrary({ assetRoot, mountPath, minimumFreeBytes: Number(minimumFreeBytesValue), requireEpisodesDirectory });
    return { available: true, detail: `媒体库已验证：${status.mountPath}，可用空间 ${status.availableBytes} 字节。` };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : "媒体库无法通过运行态检查。" };
  }
}

export function serveProductionMaterial(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.statusCode = 401;
      response.end("需要 Owner 登录会话。");
      return;
    }
    const episodeId = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("episode") ?? "";
    if (!isEpisodeId(episodeId)) {
      response.statusCode = 400;
      response.end("无效的 Episode ID。");
      return;
    }
    try {
      const assetRoot = await assetRootForOwnedEpisode({ authorization, episodeId, supabasePublishableKey, supabaseUrl });
      if (!assetRoot || !isAbsolute(assetRoot)) throw new Error("未找到可写入的 Episode 资产根。");
      const body = await readJsonBody(request);
      const sourceKind = body.sourceKind;
      const sourcePath = body.sourcePath;
      const logicalName = body.logicalName;
      const materialType = body.materialType;
      const materialPurpose = body.materialPurpose;
      const mimeType = body.mimeType;
      const isMainScript = body.isMainScript;
      const allowedMaterialPurposes = new Set(["main_script", "supplemental_script", "general_reference", "visual_reference", "a_roll", "b_roll", "narration", "background_music", "sound_effect", "cover"]);
      if ((sourceKind !== "directory" && sourceKind !== "file" && sourceKind !== "paste") || typeof sourcePath !== "string" || (logicalName !== undefined && typeof logicalName !== "string") || typeof materialType !== "string" || typeof materialPurpose !== "string" || !allowedMaterialPurposes.has(materialPurpose) || typeof mimeType !== "string" || typeof isMainScript !== "boolean") {
        throw new Error("生产材料元数据无效。");
      }
      if ((materialPurpose === "a_roll" || materialPurpose === "b_roll") && !isSupportedManualARollVideo(sourcePath, materialType, mimeType)) throw new Error("人工 A-roll/B-roll 仅支持 MP4、MOV 或 WebM 视频。");
      if ((materialPurpose === "narration" || materialPurpose === "background_music" || materialPurpose === "sound_effect") && !isSupportedManualAudio(sourcePath, materialType, mimeType)) throw new Error("人工旁白、配乐和音效仅支持常见音频文件。");
      let content: Uint8Array | undefined;
      if (sourceKind !== "directory") {
        if (typeof body.contentBase64 !== "string") throw new Error("生产材料内容无效。");
        content = Buffer.from(body.contentBase64, "base64");
      }
      if (materialPurpose === "cover" && (materialType !== "image" || !(mimeType === "application/octet-stream" || mimeType.toLowerCase().startsWith("image/")))) throw new Error("封面素材仅支持图片文件。");
      const snapshot = await saveProductionMaterialSnapshot(assetRoot, episodeId, { content, logicalName, sourceKind, sourcePath });
      if (!supabaseUrl || !supabasePublishableKey) throw new Error("Supabase 连接未配置。");
      const supabase = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
      const { data, error } = await supabase.rpc("import_production_material", {
        p_episode_id: episodeId,
        p_file_size: snapshot.fileSize,
        p_is_main_script: isMainScript,
        p_material_purpose: materialPurpose,
        p_material_type: materialType,
        p_mime_type: mimeType,
        p_sha256: snapshot.sha256,
        p_source_kind: sourceKind,
        p_source_path: snapshot.sourcePath,
        p_storage_path: snapshot.storagePath,
      });
      if (error) throw error;
      response.setHeader("Content-Type", "application/json");
      response.statusCode = 201;
      response.end(JSON.stringify(data));
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "无法导入生产材料。");
    }
  };
}

export function serveTtsVoicePreview(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) { response.statusCode = 401; response.end("需要 Owner 登录会话。"); return; }
    const episodeId = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("episode") ?? "";
    if (!isEpisodeId(episodeId)) { response.statusCode = 400; response.end("无效的 Episode ID。"); return; }
    if (!supabaseUrl || !supabasePublishableKey) { response.statusCode = 503; response.end("Supabase 连接未配置。"); return; }
    try {
      const body = await readJsonBody(request);
      const languageCode = typeof body.languageCode === "string" ? body.languageCode.trim() : "";
      const voice = typeof body.voice === "string" ? body.voice.trim() : "";
      const speakingRate = body.speakingRate;
      if (!languageCode || languageCode.length > 32 || !voice || voice.length > 128 || typeof speakingRate !== "number" || !Number.isFinite(speakingRate) || speakingRate < 0.5 || speakingRate > 2) throw new Error("语言、音色或语速无效。");
      const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
      const { data: episode, error: episodeError } = await client.from("episodes").select("account_id, blueprint_version_id").eq("id", episodeId).maybeSingle();
      if (episodeError || !episode || !await accountIsOwned({ accountId: episode.account_id, authorization, supabasePublishableKey, supabaseUrl })) { response.statusCode = 403; response.end("没有该生产单的 Owner 权限。"); return; }
      const { data: blueprint, error: blueprintError } = await client.from("account_blueprint_versions").select("policy").eq("id", episode.blueprint_version_id).eq("account_id", episode.account_id).maybeSingle();
      if (blueprintError || !blueprint) throw new Error("未找到当前蓝图。");
      const capability = runtimeCapabilitiesFromBlueprintPolicy(blueprint.policy, undefined, ["narration_generation"]).find((candidate) => candidate.capability === "narration_generation");
      if (!capability || (capability.provider !== "google_tts" && capability.provider !== "volcengine_tts")) throw new Error("当前蓝图没有可试听的 TTS 执行器。");
      const policy = blueprint.policy && typeof blueprint.policy === "object" && !Array.isArray(blueprint.policy) ? blueprint.policy as Record<string, unknown> : {};
      const narration = policy.narration && typeof policy.narration === "object" && !Array.isArray(policy.narration) ? policy.narration as Record<string, unknown> : {};
      const assetRoot = typeof policy.asset_root === "string" ? policy.asset_root.trim() : "";
      if (!assetRoot) throw new Error("当前蓝图没有本地资产根目录。");
      const resolution = registeredAdapters.resolve({ capability: capability.capability, provider: capability.provider, adapter: capability.adapter });
      const catalog = resolution.kind === "registered" ? resolution.choice.voiceCatalog?.[languageCode] : undefined;
      if (!catalog || !catalog.includes(voice)) throw new Error("所选语言或音色不在当前 TTS 执行器目录中。");
      const apiKey = await localWorkerSecretForCapability(capability, episode.account_id);
      if (!apiKey) { response.statusCode = 503; response.end("当前 TTS 凭据不可用。"); return; }
      const model = capability.model ?? (capability.provider === "volcengine_tts" ? "seed-tts-2.0" : "standard");
      const text = "你好，这是当前音色的试听效果。";
      const adapter = capability.adapter ?? capability.provider;
      const connectionVersionId = typeof narration.credential_ref === "string" ? narration.credential_ref.trim() : "";
      const preview = await cachedTtsVoicePreview(assetRoot, { adapter, connectionVersionId, languageCode, model, provider: capability.provider, speakingRate, text, textVersion: "tts-voice-preview/v1", voice }, async () => {
        const input = { apiKey, fetcher: fetch, text, voice: { languageCode, name: voice, speakingRate } };
        return capability.provider === "volcengine_tts" ? synthesizeVolcengineTts({ ...input, model }) : synthesizeGoogleTts(input);
      });
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "audio/mpeg");
      response.setHeader("X-TTS-Preview-Cache", preview.cacheStatus);
      response.statusCode = 200;
      response.end(preview.audio);
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "无法试听当前音色。");
    }
  };
}

export interface TtsVoicePreviewIdentity {
  adapter: string;
  connectionVersionId: string;
  languageCode: string;
  model: string;
  provider: string;
  speakingRate: number;
  text: string;
  textVersion: string;
  voice: string;
}

const ttsVoicePreviewInFlight = new Map<string, Promise<{ audio: Buffer; cacheStatus: "HIT" | "MISS" }>>();

async function validateTtsVoicePreviewAudio(bytes: Uint8Array): Promise<void> {
  const directory = await fs.mkdtemp(join(tmpdir(), "loop-control-tts-preview-"));
  const path = join(directory, "preview.mp3");
  try {
    await fs.writeFile(path, bytes);
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]);
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("音色试听音频无法播放。");
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

export async function cachedTtsVoicePreview(assetRoot: string, identity: TtsVoicePreviewIdentity, synthesize: () => Promise<Uint8Array>, validateAudio: (bytes: Uint8Array) => Promise<void> = validateTtsVoicePreviewAudio): Promise<{ audio: Buffer; cacheStatus: "HIT" | "MISS" }> {
  const resolvedRoot = await fs.realpath(assetRoot);
  if (isFilesystemRoot(resolvedRoot)) throw new Error("资产根不能是文件系统根目录。");
  const cacheRoot = await ensureDirectoryWithinRoot(resolvedRoot, resolve(resolvedRoot, ".cache"));
  const cacheDirectory = await ensureDirectoryWithinRoot(cacheRoot, resolve(cacheRoot, "tts-previews"));
  const cachePath = resolve(cacheDirectory, `${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.mp3`);
  try {
    return { audio: await fs.readFile(cachePath), cacheStatus: "HIT" };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const inFlight = ttsVoicePreviewInFlight.get(cachePath);
  if (inFlight) return inFlight;
  const pending = (async () => {
    const audio = Buffer.from(await synthesize());
    if (audio.byteLength === 0) throw new Error("音色试听没有返回音频。");
    await validateAudio(audio);
    const temporaryPath = resolve(cacheDirectory, `.${basename(cachePath)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, audio, { flag: "wx" });
      try {
        await fs.link(temporaryPath, cachePath);
        return { audio, cacheStatus: "MISS" as const };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        return { audio: await fs.readFile(cachePath), cacheStatus: "HIT" as const };
      }
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  })();
  ttsVoicePreviewInFlight.set(cachePath, pending);
  try {
    return await pending;
  } finally {
    if (ttsVoicePreviewInFlight.get(cachePath) === pending) ttsVoicePreviewInFlight.delete(cachePath);
  }
}

async function indexedArtifactForPreview(input: { authorization: string; episodeId: string; expectedSha256?: string; relativePath: string; supabasePublishableKey: string | undefined; supabaseUrl: string | undefined }): Promise<{ assetRoot: string; sha256: string } | null> {
  if (!input.supabaseUrl || !input.supabasePublishableKey) return null;
  const supabase = createClient(input.supabaseUrl, input.supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: input.authorization } } });

  let artifactQuery = supabase.from("artifacts").select("episode_id, sha256").eq("episode_id", input.episodeId).eq("relative_path", input.relativePath);
  if (input.expectedSha256) artifactQuery = artifactQuery.eq("sha256", input.expectedSha256);
  const { data: artifacts, error: artifactError } = await artifactQuery.order("created_at", { ascending: false }).limit(1);
  if (artifactError) return null;
  const artifact = artifacts?.[0] ?? null;
  let materialQuery = supabase.from("production_material_revisions").select("episode_id, sha256").eq("episode_id", input.episodeId).eq("storage_path", input.relativePath);
  if (input.expectedSha256) materialQuery = materialQuery.eq("sha256", input.expectedSha256);
  const { data: materials, error: materialError } = artifact ? { data: null, error: null } : await materialQuery.order("created_at", { ascending: false }).limit(1);
  if (materialError) return null;
  const indexedInput = artifact ?? materials?.[0];
  if (!indexedInput) return null;

  const { data: episode, error: episodeError } = await supabase.from("episodes").select("blueprint_version_id").eq("id", indexedInput.episode_id).maybeSingle();
  if (episodeError || !episode) return null;

  const { data: blueprint, error: blueprintError } = await supabase.from("account_blueprint_versions").select("policy").eq("id", episode.blueprint_version_id).maybeSingle();
  if (blueprintError || !blueprint || !blueprint.policy || Array.isArray(blueprint.policy) || typeof blueprint.policy !== "object") return null;
  const assetRoot = blueprint.policy.asset_root;
  return typeof assetRoot === "string" && assetRoot.trim() ? { assetRoot: assetRoot.trim(), sha256: indexedInput.sha256 } : null;
}

async function assetRootForOwnedEpisode(input: { authorization: string; episodeId: string; supabasePublishableKey: string | undefined; supabaseUrl: string | undefined }): Promise<string | null> {
  if (!input.supabaseUrl || !input.supabasePublishableKey) return null;
  const accessToken = input.authorization.slice("Bearer ".length);
  const supabase = createClient(input.supabaseUrl, input.supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: input.authorization } } });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return null;

  const { data: episode, error: episodeError } = await supabase.from("episodes").select("account_id, blueprint_version_id").eq("id", input.episodeId).maybeSingle();
  if (episodeError || !episode) return null;

  const { data: membership, error: membershipError } = await supabase.from("account_memberships").select("role").eq("account_id", episode.account_id).eq("user_id", userData.user.id).eq("role", "owner").maybeSingle();
  if (membershipError || !membership) return null;

  const { data: blueprint, error: blueprintError } = await supabase.from("account_blueprint_versions").select("policy").eq("id", episode.blueprint_version_id).maybeSingle();
  if (blueprintError || !blueprint || !blueprint.policy || Array.isArray(blueprint.policy) || typeof blueprint.policy !== "object") return null;
  const assetRoot = blueprint.policy.asset_root;
  return typeof assetRoot === "string" ? assetRoot.trim() || null : null;
}

function shotWorkbenchDurationSettingsFromRules(rules: unknown): { frameRate: number; allowedFrames: number } {
  const root = rules && typeof rules === "object" && !Array.isArray(rules) ? rules as Record<string, unknown> : {};
  const composition = root.openchatcut_composition;
  const values = composition && typeof composition === "object" && !Array.isArray(composition) ? composition as Record<string, unknown> : {};
  const frameRate = typeof values.frame_rate === "number" && Number.isFinite(values.frame_rate) && values.frame_rate > 0 ? values.frame_rate : 30;
  const allowedFrames = typeof values.allowed_frames === "number" && Number.isInteger(values.allowed_frames) && values.allowed_frames >= 0 ? values.allowed_frames : 2;
  return { frameRate, allowedFrames };
}

const editableShotWorkbenchStages = new Set(["storyboard_approved", "production_ready", "render_ready", "qc_review"]);

export function studioEntryModeForPaths(stage: string, requestedPath: string, storyboardPath?: string): "shot_workbench" | "review_render" | "storyboard_mismatch" {
  if (editableShotWorkbenchStages.has(stage) && storyboardPath === requestedPath) return "shot_workbench";
  return stage === "storyboard_approved" ? "storyboard_mismatch" : "review_render";
}

async function studioEntryGateForOwnedEpisode(input: { assetRoot: string; authorization: string; episodeId: string; projectRelativePath: string; supabasePublishableKey: string | undefined; supabaseUrl: string | undefined }): Promise<{ allowed: boolean; mode?: "review_render" | "shot_workbench"; message?: string; storyboardPackageId?: string; reviewRenderTaskId?: string; durationSettings?: { frameRate: number; allowedFrames: number } }> {
  if (!input.supabaseUrl || !input.supabasePublishableKey) return { allowed: false, message: "Supabase 本地客户端未配置。" };
  const supabase = createClient(input.supabaseUrl, input.supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: input.authorization } } });
  const { data: episode, error: episodeError } = await supabase.from("episodes").select("stage, account_id, series_version_id").eq("id", input.episodeId).maybeSingle();
  if (episodeError || !episode) return { allowed: false, message: "未找到当前 Episode。" };
  let storyboardPackage: { id: string; artifact_id: string } | undefined;
  let storyboardArtifactPath: string | undefined;
  if (editableShotWorkbenchStages.has(episode.stage)) {
    const { data: packages, error: packageError } = await supabase.from("review_packages").select("id, artifact_id").eq("episode_id", input.episodeId).eq("stage", "storyboard_review").is("invalidated_at", null).order("revision_number", { ascending: false }).limit(1);
    storyboardPackage = packages?.[0];
    if (!packageError && storyboardPackage) {
      const { data: artifact, error: artifactError } = await supabase.from("artifacts").select("relative_path").eq("id", storyboardPackage.artifact_id).maybeSingle();
      if (!artifactError) storyboardArtifactPath = artifact?.relative_path;
    }
  }
  const entryMode = studioEntryModeForPaths(episode.stage, input.projectRelativePath, storyboardArtifactPath);
  if (entryMode === "storyboard_mismatch") return { allowed: false, message: "Studio 工程不是当前分镜版本。" };
  if (entryMode === "shot_workbench" && storyboardPackage) {
    let durationSettings = { frameRate: 30, allowedFrames: 2 };
    if (episode.series_version_id) {
      const { data: seriesVersion, error: seriesVersionError } = await supabase.from("series_versions").select("rules").eq("id", episode.series_version_id).eq("account_id", episode.account_id).maybeSingle();
      if (seriesVersionError) return { allowed: false, message: "无法读取当前 Episode 的镜头时长规则。" };
      durationSettings = shotWorkbenchDurationSettingsFromRules(seriesVersion?.rules);
    }
    const root = await fs.realpath(input.assetRoot);
    const storyboardPath = await fs.realpath(resolve(root, input.projectRelativePath));
    if (!isDescendant(root, storyboardPath)) return { allowed: false, message: "Studio 工程超出资产根。" };
    let storyboard: StoryboardManifest;
    try { storyboard = JSON.parse(await fs.readFile(storyboardPath, "utf8")) as StoryboardManifest; } catch { return { allowed: false, message: "当前分镜版本无效。" }; }
    const { data: drafts, error: draftsError } = await supabase.from("shot_preparation_drafts").select("shot_id, selected_material_revision_id").eq("episode_id", input.episodeId).eq("review_package_id", storyboardPackage.id);
    if (draftsError) return { allowed: false, message: "无法确认当前镜头版本，请稍后重试。" };
    const draftByShot = new Map((drafts ?? []).map((draft) => [draft.shot_id, draft.selected_material_revision_id]));
    const missingShotIds = storyboard.shots.filter((shot) => typeof draftByShot.get(shot.id) !== "string" || !draftByShot.get(shot.id)).map((shot) => shot.id);
    if (missingShotIds.length) return { allowed: false, message: `Studio 尚未就绪，请先补齐镜头素材：${missingShotIds.join("、")}。` };
    return { allowed: true, mode: "shot_workbench", storyboardPackageId: storyboardPackage.id, durationSettings };
  }
  const { data: qcPackages, error: qcError } = await supabase.from("review_packages").select("id, task_id, context_snapshot").eq("episode_id", input.episodeId).eq("stage", "qc_review").is("invalidated_at", null).order("revision_number", { ascending: false }).limit(1);
  const qcPackage = qcPackages?.[0];
  if (qcError || !qcPackage) return { allowed: false, message: "未找到当前审核渲染工程。" };
  const qcSnapshot = qcPackage.context_snapshot && typeof qcPackage.context_snapshot === "object" && !Array.isArray(qcPackage.context_snapshot) ? qcPackage.context_snapshot as Record<string, unknown> : {};
  if (qcSnapshot.project_relative_path !== input.projectRelativePath) return { allowed: false, message: "Studio 工程不是当前审核渲染工程。" };

  const preRenderPackageId = typeof qcSnapshot.pre_render_review_package_id === "string" ? qcSnapshot.pre_render_review_package_id : undefined;
  if (!preRenderPackageId) return { allowed: true, mode: "review_render", reviewRenderTaskId: qcPackage.task_id };
  const { data: preRenderPackage, error: preRenderError } = await supabase.from("review_packages").select("id").eq("id", preRenderPackageId).eq("episode_id", input.episodeId).eq("stage", "production_ready").is("invalidated_at", null).maybeSingle();
  if (preRenderError || !preRenderPackage) return { allowed: false, message: "当前 Studio 输入快照不存在或已失效。" };
  return { allowed: true, mode: "review_render", reviewRenderTaskId: qcPackage.task_id };
}

async function accountIsOwned(input: { accountId: string; authorization: string; supabasePublishableKey: string | undefined; supabaseUrl: string | undefined }): Promise<boolean> {
  if (!input.supabaseUrl || !input.supabasePublishableKey) return false;
  const accessToken = input.authorization.slice("Bearer ".length);
  const supabase = createClient(input.supabaseUrl, input.supabasePublishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: input.authorization } } });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return false;
  const { data: membership, error: membershipError } = await supabase.from("account_memberships").select("role").eq("account_id", input.accountId).eq("user_id", userData.user.id).eq("role", "owner").maybeSingle();
  return !membershipError && Boolean(membership);
}

function localArtifactPreviewPlugin(supabaseUrl: string | undefined, supabasePublishableKey: string | undefined): Plugin {
  const artifactMiddleware = serveLocalArtifact(supabaseUrl, supabasePublishableKey);
  const openArtifactMiddleware = serveOpenLocalArtifact(supabaseUrl, supabasePublishableKey);
  const directoryMiddleware = serveLocalEpisodeDirectory(supabaseUrl, supabasePublishableKey);
  const openDirectoryMiddleware = serveOpenLocalEpisodeDirectory(supabaseUrl, supabasePublishableKey);
  const openOpenChatCutStudioMiddleware = serveOpenOpenChatCutStudio(supabaseUrl, supabasePublishableKey);
  const freezeOpenChatCutStudioMiddleware = serveFreezeOpenChatCutStudio(supabaseUrl, supabasePublishableKey);
  const chooseAssetDirectoryMiddleware = serveChooseLocalAssetDirectory(supabaseUrl, supabasePublishableKey);
  const openAssetDirectoryMiddleware = serveOpenLocalAssetDirectory(supabaseUrl, supabasePublishableKey);
  const productionMaterialMiddleware = serveProductionMaterial(supabaseUrl, supabasePublishableKey);
  const ttsVoicePreviewMiddleware = serveTtsVoicePreview(supabaseUrl, supabasePublishableKey);
  const deletionMiddleware = serveEpisodeDeletion(supabaseUrl, supabasePublishableKey, localWorkerServiceRoleKey());
  const deletionCleanupMiddleware = serveEpisodeDeletionCleanup(supabaseUrl, supabasePublishableKey);
  const systemStatusMiddleware = serveSystemStatus(supabaseUrl, supabasePublishableKey);
  const goldenProductionTestMiddleware = serveGoldenProductionTest(supabaseUrl, supabasePublishableKey);
  const episodePreflightMiddleware = serveEpisodePreflight(supabaseUrl, supabasePublishableKey);
  const episodeDispatchMiddleware = serveEpisodeDispatch(supabaseUrl, supabasePublishableKey);
  const externalConnectionTestMiddleware = serveExternalConnectionTest(supabaseUrl, supabasePublishableKey, localWorkerServiceRoleKey());
  const publishPreparationMiddleware = servePublishPreparation(supabaseUrl, supabasePublishableKey, localWorkerServiceRoleKey());
  const workerPreflightMiddleware = serveWorkerPreflight(supabaseUrl, supabasePublishableKey);
  return {
    name: "local-artifact-preview",
    configureServer(server) {
      server.middlewares.use(localArtifactRoute, artifactMiddleware);
      server.middlewares.use(openLocalArtifactRoute, openArtifactMiddleware);
      server.middlewares.use(localEpisodeDirectoryRoute, directoryMiddleware);
      server.middlewares.use(openLocalEpisodeDirectoryRoute, openDirectoryMiddleware);
      server.middlewares.use(openOpenChatCutStudioRoute, openOpenChatCutStudioMiddleware);
      server.middlewares.use(freezeOpenChatCutStudioRoute, freezeOpenChatCutStudioMiddleware);
      server.middlewares.use(chooseLocalAssetDirectoryRoute, chooseAssetDirectoryMiddleware);
      server.middlewares.use(openLocalAssetDirectoryRoute, openAssetDirectoryMiddleware);
      server.middlewares.use(localProductionMaterialRoute, productionMaterialMiddleware);
      server.middlewares.use(ttsVoicePreviewRoute, ttsVoicePreviewMiddleware);
      server.middlewares.use(localEpisodeDeletionRoute, deletionMiddleware);
      server.middlewares.use(localEpisodeDeletionCleanupRoute, deletionCleanupMiddleware);
      server.middlewares.use(systemStatusRoute, systemStatusMiddleware);
      server.middlewares.use(goldenProductionTestRoute, goldenProductionTestMiddleware);
      server.middlewares.use(episodePreflightRoute, episodePreflightMiddleware);
      server.middlewares.use(episodeDispatchRoute, episodeDispatchMiddleware);
      server.middlewares.use(externalConnectionTestRoute, externalConnectionTestMiddleware);
      server.middlewares.use(publishPreparationRoute, publishPreparationMiddleware);
      server.middlewares.use(workerPreflightRoute, workerPreflightMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(localArtifactRoute, artifactMiddleware);
      server.middlewares.use(openLocalArtifactRoute, openArtifactMiddleware);
      server.middlewares.use(localEpisodeDirectoryRoute, directoryMiddleware);
      server.middlewares.use(openLocalEpisodeDirectoryRoute, openDirectoryMiddleware);
      server.middlewares.use(openOpenChatCutStudioRoute, openOpenChatCutStudioMiddleware);
      server.middlewares.use(freezeOpenChatCutStudioRoute, freezeOpenChatCutStudioMiddleware);
      server.middlewares.use(chooseLocalAssetDirectoryRoute, chooseAssetDirectoryMiddleware);
      server.middlewares.use(openLocalAssetDirectoryRoute, openAssetDirectoryMiddleware);
      server.middlewares.use(localProductionMaterialRoute, productionMaterialMiddleware);
      server.middlewares.use(ttsVoicePreviewRoute, ttsVoicePreviewMiddleware);
      server.middlewares.use(localEpisodeDeletionRoute, deletionMiddleware);
      server.middlewares.use(localEpisodeDeletionCleanupRoute, deletionCleanupMiddleware);
      server.middlewares.use(systemStatusRoute, systemStatusMiddleware);
      server.middlewares.use(goldenProductionTestRoute, goldenProductionTestMiddleware);
      server.middlewares.use(episodePreflightRoute, episodePreflightMiddleware);
      server.middlewares.use(episodeDispatchRoute, episodeDispatchMiddleware);
      server.middlewares.use(externalConnectionTestRoute, externalConnectionTestMiddleware);
      server.middlewares.use(publishPreparationRoute, publishPreparationMiddleware);
      server.middlewares.use(workerPreflightRoute, workerPreflightMiddleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), localArtifactPreviewPlugin(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY)],
    server: { watch: { ignored: ["**/n8n/runtime/**", "**/outputs/**"] } },
    test: {
      environment: "jsdom",
      globals: true,
    },
  };
});
