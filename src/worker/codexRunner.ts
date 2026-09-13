import {
  createWorkerTaskPackage,
  missingVisualAssetAdapterMessage,
  workerPreflightVersion,
  type ArtifactManifest,
  type ReviewRenderAdjustments,
  type StoryboardManifest,
  type WorkerResult,
  type WorkerTaskPackageInput,
  type WorkerTaskPackage,
  type PromptContextSnapshot,
  type WorkerPreflightResult,
  type WorkerPreflightCheck,
  type ShotPreparationContract,
  validateWorkerResult,
} from "./contracts.js";
import { registeredAdapters } from "./registeredAdapters.js";
import { validateStoryboardManifest } from "./contracts.js";
import type { StoryboardStructureRevision } from "./storyboardRevision.js";
import { defaultAllowedDurationFrames, defaultDurationFrameRate, shotDurationDecisionFromJson } from "./durationDecision.js";
import { isValidShotComposition, normalizeShotComposition, shotTransitionModes, type ShotComposition, type ShotTransitionMode } from "../shotComposition.js";
import { isValidShotCaptionContract, normalizeShotCaptionContract, type ShotCaptionContract } from "../shotCaptions.js";
import { isValidShotAudioMix, normalizeShotAudioMix } from "../shotAudioMix.js";

export interface ClaimedWorkerTask {
  taskId: string;
  taskType: string;
  attempt: number;
  budgetLimitCents: number;
  maxAttempts: number;
  provider: "codex" | "google_tts" | "volcengine_tts" | "pexels" | "ffmpeg" | "freesound" | "openchatcut" | "openai" | "cloudflare" | "whisperx";
  model: string;
  promptVersion: string;
  episodeId: string;
  accountId: string;
  blueprintVersionId: string;
  title: string;
  allowedAssetRoot: string;
  inputSnapshot: unknown;
}

export interface CodexWorkerDependencies {
  claimNextTask(): Promise<ClaimedWorkerTask | null>;
  verifyAssetRoot(allowedAssetRoot: string): Promise<void>;
  verifyArtifacts(taskPackage: WorkerTaskPackage, artifacts: ArtifactManifest[], storyboard?: WorkerResult["storyboard"]): Promise<void>;
  execute(taskPackage: WorkerTaskPackage): Promise<string>;
  preflight?(taskPackage: WorkerTaskPackage): Promise<WorkerPreflightResult>;
  reportProgress?(taskId: string, attempt: number, progress: WorkerProgress): Promise<void>;
  reportResult(taskId: string, attempt: number, result: WorkerResult): Promise<void>;
  actualCostCents: number;
}

export type WorkerProgressStep = "preflight" | "input_validation" | "provider_execution" | "output_validation";

export interface WorkerProgress {
  version: "worker-progress/v1";
  step: WorkerProgressStep;
  detail: string;
  observedAt: string;
}

export type CodexWorkerRunResult =
  | { status: "idle" }
  | { status: "completed" | "blocked" | "failed"; taskId: string };

export async function runCodexWorker(dependencies: CodexWorkerDependencies): Promise<CodexWorkerRunResult> {
  const task = await dependencies.claimNextTask();
  if (!task) return { status: "idle" };

  let taskPackage: WorkerTaskPackage;
  try {
    taskPackage = createTaskPackage(task);
  } catch (error) {
    const missingVisualAssetAdapter = errorMessage(error) === missingVisualAssetAdapterMessage;
    const result = createBlockedResult(task.taskId, dependencies.actualCostCents, error, missingVisualAssetAdapter ? "capability_registration" : undefined);
    if (missingVisualAssetAdapter) {
      const check: WorkerPreflightCheck = {
        capability: "static_visual_generation",
        check: "capability_registration",
        phase: "preflight",
        status: "unavailable",
        reason: missingVisualAssetAdapterMessage,
        action: "contact_environment_admin",
        scope: "worker",
      };
      result.preflight = { version: workerPreflightVersion, checks: [check] };
      result.blockers = [preflightBlocker(check)];
      result.nextStep = "Register an image-generation Adapter in the Worker environment before creating a new task attempt.";
    }
    await dependencies.reportResult(task.taskId, task.attempt, result);
    return { status: "blocked", taskId: task.taskId };
  }

  await reportProgress(dependencies, task, "preflight", "正在检查执行器、模型、连接和本机依赖。");
  const preflight = dependencies.preflight && !taskPackage.storyboardRevision ? await runPreflight(dependencies.preflight, taskPackage) : undefined;
  if (preflight) {
    if (preflight.checks.some((check) => check.status !== "passed")) {
      const result = createPreflightResult(taskPackage, dependencies.actualCostCents, preflight);
      await dependencies.reportResult(task.taskId, task.attempt, result);
      return { status: result.status, taskId: task.taskId };
    }
  }

  await reportProgress(dependencies, task, "input_validation", "正在验证媒体库与冻结输入。");
  try {
    await dependencies.verifyAssetRoot(taskPackage.assets.allowedRoot);
  } catch (error) {
    const check: WorkerPreflightCheck = {
      capability: taskPackage.capability,
      check: "asset_root",
      phase: "preflight",
      status: "unavailable",
      reason: errorMessage(error),
      action: "contact_environment_admin",
      scope: "worker",
    };
    const result = createBlockedResult(task.taskId, dependencies.actualCostCents, error, "asset_root_unavailable");
    result.preflight = appendPreflight(preflight, check);
    result.blockers = [{ ...preflightBlocker(check), code: "asset_root_unavailable", detail: check.reason }];
    await dependencies.reportResult(task.taskId, task.attempt, result);
    return { status: "blocked", taskId: task.taskId };
  }

  try {
    await dependencies.verifyArtifacts(taskPackage, taskPackage.assets.inputs);
  } catch (error) {
    await dependencies.reportResult(task.taskId, task.attempt, addPreflight(createBlockedResult(task.taskId, dependencies.actualCostCents, error, "input_artifacts_invalid"), preflight));
    return { status: "blocked", taskId: task.taskId };
  }

  await reportProgress(dependencies, task, "provider_execution", `正在由 ${task.provider} 执行 ${task.taskType}。`);
  try {
    const output = await dependencies.execute(taskPackage);
    const candidate = parseCodexOutput(output, dependencies.actualCostCents);
    const result = validateWorkerResult(candidate, taskPackage);
    if (preflight) result.preflight = preflight;
    await reportProgress(dependencies, task, "output_validation", "执行已返回，正在校验并登记产物。");
    await dependencies.verifyArtifacts(taskPackage, result.artifacts, result.storyboard);
    await dependencies.reportResult(task.taskId, task.attempt, result);
    return { status: result.status, taskId: task.taskId };
  } catch (error) {
    const executionCheck = executionPreflightCheck(taskPackage, error);
    const result = createFailedResult(taskPackage, dependencies.actualCostCents, error);
    if (executionCheck) result.blockers = [preflightBlocker(executionCheck)];
    await dependencies.reportResult(task.taskId, task.attempt, addPreflight(result, executionCheck ? appendPreflight(preflight, executionCheck) : preflight));
    return { status: "failed", taskId: task.taskId };
  }
}

async function reportProgress(dependencies: CodexWorkerDependencies, task: ClaimedWorkerTask, step: WorkerProgressStep, detail: string): Promise<void> {
  if (!dependencies.reportProgress) return;
  try {
    await dependencies.reportProgress(task.taskId, task.attempt, { version: "worker-progress/v1", step, detail, observedAt: new Date().toISOString() });
  } catch {
    // Progress is observability evidence; a transient reporting failure must not fail the production task itself.
  }
}

async function runPreflight(preflight: NonNullable<CodexWorkerDependencies["preflight"]>, taskPackage: WorkerTaskPackage): Promise<WorkerPreflightResult> {
  try {
    return await preflight(taskPackage);
  } catch (error) {
    return {
      version: workerPreflightVersion,
      checks: [{
        capability: taskPackage.capability,
        check: "preflight",
        phase: "preflight",
        status: "unavailable",
        reason: errorMessage(error),
        action: "contact_environment_admin",
        scope: "worker",
      }],
    };
  }
}

function createTaskPackage(task: ClaimedWorkerTask): WorkerTaskPackage {
  const snapshot = isRecord(task.inputSnapshot) ? task.inputSnapshot : {};
  const output = outputContract(snapshot);
  return createWorkerTaskPackage({
    task: {
      id: task.taskId,
      type: task.taskType,
      attempt: task.attempt,
      budgetLimitCents: task.budgetLimitCents,
      maxAttempts: task.maxAttempts,
      provider: task.provider,
      model: task.model,
      promptVersion: task.promptVersion,
    },
    episode: {
      id: task.episodeId,
      accountId: task.accountId,
      blueprintVersionId: task.blueprintVersionId,
      title: task.title,
    },
    capability: requiredString(snapshot.capability, "任务缺少能力声明。"),
    ...(typeof snapshot.credential_ref === "string" ? { credentialRef: snapshot.credential_ref } : {}),
    acousticAlignment: acousticAlignmentInput(snapshot),
    promptContext: promptContext(snapshot),
    promptHarness: promptHarness(snapshot),
    commission: commission(snapshot),
    seriesBaseline: seriesBaseline(snapshot),
    visualAssetPreparation: visualAssetPreparation(snapshot),
    reviewFeedback: reviewFeedback(snapshot),
    reviewAnnotations: reviewAnnotations(snapshot),
    storyboardRevision: storyboardRevision(snapshot, inputArtifacts(snapshot)),
    aRoll: aRoll(snapshot),
    media: media(snapshot),
    reviewRender: reviewRenderFromSnapshot(snapshot),
    finalRender: finalRender(snapshot),
    allowedTools: stringArray(snapshot.allowed_tools, "任务允许工具清单格式无效。"),
    allowedAssetRoot: task.allowedAssetRoot,
    output,
    inputArtifacts: inputArtifacts(snapshot),
  });
}

function acousticAlignmentInput(snapshot: Record<string, unknown>): WorkerTaskPackageInput["acousticAlignment"] {
  if (snapshot.acoustic_alignment === undefined) return undefined;
  if (!isRecord(snapshot.acoustic_alignment)) throw new Error("声学对齐冻结输入格式无效。");
  const value = snapshot.acoustic_alignment;
  return {
    confirmedText: requiredString(value.confirmed_text, "声学对齐缺少 Owner 字幕正文。"),
    textFingerprint: requiredString(value.text_fingerprint, "声学对齐缺少字幕正文版本。"),
    ...(typeof value.audio_relative_path === "string" ? { audioRelativePath: value.audio_relative_path } : {}),
    ...(typeof value.audio_sha256 === "string" ? { audioSha256: value.audio_sha256 } : {}),
    ...(typeof value.input_version === "string" ? { inputVersion: value.input_version } : {}),
    ...(typeof value.speaking_rate === "number" ? { speakingRate: value.speaking_rate } : {}),
    ...(value.strategy === "auto" || value.strategy === "local" ? { strategy: value.strategy } : {}),
    ...(typeof value.voice === "string" ? { voice: value.voice } : {}),
  };
}

function storyboardRevision(snapshot: Record<string, unknown>, frozenInputs: ArtifactManifest[]): StoryboardStructureRevision | undefined {
  if (snapshot.storyboard_revision === undefined) return undefined;
  if (!isRecord(snapshot.storyboard_revision) || snapshot.storyboard_revision.version !== "storyboard-revision/v1" || typeof snapshot.storyboard_revision.base_review_package_id !== "string" || typeof snapshot.storyboard_revision.input_fingerprint !== "string" || !isRecord(snapshot.storyboard_revision.operation) || !isRecord(snapshot.storyboard_revision.storyboard)) throw new Error("分镜结构修订任务格式无效。");
  const revision = snapshot.storyboard_revision;
  const storyboard = validateStoryboardManifest(revision.storyboard, frozenInputs);
  return {
    version: "storyboard-revision/v1",
    baseReviewPackageId: revision.base_review_package_id as string,
    inputFingerprint: revision.input_fingerprint as string,
    operation: revision.operation as StoryboardStructureRevision["operation"],
    storyboard,
  };
}

function promptContext(snapshot: Record<string, unknown>): WorkerTaskPackageInput["promptContext"] {
  const value = snapshot.prompt_context;
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== "prompt-context/v1" || typeof value.blueprint_version_id !== "string" || typeof value.hash !== "string" || !isRecord(value.account_hard_constraints) || !isRecord(value.account_defaults) || !isRecord(value.episode_input)) throw new Error("任务 Prompt 上下文格式无效。");
  return {
    version: "prompt-context/v1",
    blueprintVersionId: value.blueprint_version_id,
    ...(typeof value.series_version_id === "string" ? { seriesVersionId: value.series_version_id } : {}),
    accountHardConstraints: value.account_hard_constraints,
    accountDefaults: value.account_defaults,
    ...(value.series_baseline && isRecord(value.series_baseline) ? { seriesBaseline: value.series_baseline } : {}),
    episodeInput: value.episode_input,
    ...(value.review_feedback && isRecord(value.review_feedback) ? { reviewFeedback: value.review_feedback } : {}),
    hash: value.hash,
  } satisfies PromptContextSnapshot;
}

function finalRender(snapshot: Record<string, unknown>): WorkerTaskPackageInput["finalRender"] {
  if (snapshot.capability !== "final_rendering") return undefined;
  const value = snapshot.final_render;
  if (!isRecord(value)) throw new Error("最终渲染任务冻结工程格式无效。");
  const sourceProject = artifactManifest(value.source_project, "最终渲染任务缺少审核工程证据。");
  const sourceRuntime = artifactManifest(value.source_runtime, "最终渲染任务缺少审核运行时证据。");
  const sourceQcReport = artifactManifest(value.source_qc_report, "最终渲染任务缺少 QC 报告证据。");
  const review = reviewRenderFromSnapshot({ capability: "review_rendering", review_render: value.review_render });
  if (!review) throw new Error("最终渲染任务缺少审核工程。");
  return { sourceReviewPackageId: requiredString(value.source_review_package_id, "最终渲染任务缺少审核包。"), sourceProject, sourceRuntime, sourceQcReport, projectRelativePath: requiredString(value.project_relative_path, "最终渲染任务缺少工程路径。"), projectRevision: requiredPositiveNumber(value.project_revision, "最终渲染任务缺少工程修订。"), reviewRender: review };
}

function artifactManifest(value: unknown, message: string) {
  if (!isRecord(value)) throw new Error(message);
  return { artifactType: requiredString(value.artifact_type, message), relativePath: requiredString(value.relative_path, message), sha256: requiredString(value.sha256, message), fileSize: requiredNonNegativeNumber(value.file_size, message) };
}

export function reviewRenderFromSnapshot(snapshot: Record<string, unknown>): WorkerTaskPackageInput["reviewRender"] {
  if (snapshot.capability !== "review_rendering") return undefined;
  const value = snapshot.review_render;
  if (!isRecord(value) || !isRecord(value.storyboard) || !Array.isArray(value.members)) throw new Error("审核渲染任务冻结工程格式无效。");
  const storyboard = value.storyboard;
  if (storyboard.version !== "storyboard/v1" || !Array.isArray(storyboard.shots) || !Array.isArray(storyboard.audioCues)) throw new Error("审核渲染任务缺少冻结分镜。");
  if (value.confirmation_mode !== "shot_preparation" || !Array.isArray(value.confirmed_shots)) throw new Error("OpenChatCut 新工程缺少版本化镜头准备契约。");
  return {
    projectRelativePath: requiredString(value.project_relative_path, "审核渲染任务缺少工程路径。"),
    projectRevision: requiredPositiveNumber(value.project_revision, "审核渲染任务缺少工程修订。"),
    preRenderReviewPackageId: requiredString(value.pre_render_review_package_id, "审核渲染任务缺少预渲染审核包。"),
    confirmationMode: requiredConfirmationMode(value.confirmation_mode),
    confirmedShots: confirmedShots(value.confirmed_shots),
    ...(value.studio_project === undefined && (!isRecord(value.adjustments) || value.adjustments.studio_project === undefined) ? {} : { studioProject: studioProject(value.studio_project ?? (value.adjustments as Record<string, unknown>).studio_project) }),
    ...(value.studio_project_revision === undefined && (!isRecord(value.adjustments) || value.adjustments.studio_project_revision === undefined) ? {} : { studioProjectRevision: requiredString(value.studio_project_revision ?? (value.adjustments as Record<string, unknown>).studio_project_revision, "Studio 冻结工程缺少修订号。") }),
    adjustments: reviewRenderAdjustments(value.adjustments),
    storyboard: storyboard as unknown as StoryboardManifest,
    members: value.members.map((member) => {
      if (!isRecord(member)) throw new Error("审核渲染任务成员格式无效。");
      const subtitlesEnabled = member.subtitles_enabled === undefined || member.subtitles_enabled === null ? undefined : requiredBoolean(member.subtitles_enabled, "审核渲染成员字幕开关格式无效。");
      return {
        memberKey: requiredString(member.member_key, "审核渲染成员缺少标识。"),
        memberKind: requiredReviewRenderMemberKind(member.member_kind),
        ...(member.audio_kind === "bgm" || member.audio_kind === "sfx" ? { audioKind: member.audio_kind } : {}),
        ...(member.task_id === undefined || member.task_id === null ? {} : { taskId: requiredString(member.task_id, "审核渲染成员缺少任务版本。") }),
        ...(member.artifact_id === undefined || member.artifact_id === null ? {} : { artifactId: requiredString(member.artifact_id, "审核渲染成员缺少产物版本。") }),
        ...(member.source_material_revision_id === undefined || member.source_material_revision_id === null ? {} : { sourceMaterialRevisionId: requiredString(member.source_material_revision_id, "审核渲染成员缺少原片版本。") }),
        ...(member.clip_segments === undefined || member.clip_segments === null ? {} : { clipSegments: clipSegments(member.clip_segments) }),
        ...(member.composition === undefined || member.composition === null ? {} : { composition: shotComposition(member.composition, Array.isArray(member.clip_segments) ? member.clip_segments.length : 1) }),
        ...(member.preparation_contract === undefined || member.preparation_contract === null ? {} : { preparationContract: shotPreparationContract(member.preparation_contract) }),
        ...(member.audio_track_id === null ? { audioTrackId: null } : member.audio_track_id === undefined ? {} : { audioTrackId: requiredString(member.audio_track_id, "审核渲染成员缺少音轨版本。") }),
        ...(member.input_fingerprint === undefined || member.input_fingerprint === null ? {} : { inputFingerprint: requiredString(member.input_fingerprint, "审核渲染成员缺少输入版本。") }),
        ...(member.audio_mode === undefined || member.audio_mode === null ? {} : { audioMode: requiredAudioMode(member.audio_mode) }),
        ...(member.subtitle_text === undefined || member.subtitle_text === null ? {} : { subtitleText: requiredSubtitleText(member.subtitle_text, subtitlesEnabled !== false, "审核渲染成员缺少字幕文本。") }),
        ...(subtitlesEnabled === undefined ? {} : { subtitlesEnabled }),
        ...(member.duration_decision === undefined || member.duration_decision === null ? {} : { durationDecision: shotDurationDecisionFromJson(member.duration_decision) }),
        relativePath: requiredString(member.relative_path, "审核渲染成员缺少路径。"),
        sha256: requiredString(member.sha256, "审核渲染成员缺少哈希。"),
        startSeconds: requiredNonNegativeNumber(member.start_seconds, "审核渲染成员缺少起始时间。"),
        durationSeconds: requiredPositiveNumber(member.duration_seconds, "审核渲染成员缺少时长。"),
      };
    }),
  };
}

function confirmedShots(value: unknown): NonNullable<WorkerTaskPackageInput["reviewRender"]>["confirmedShots"] {
  if (!Array.isArray(value)) throw new Error("逐镜头 Studio 确认快照格式无效。");
  return value.map((shot) => {
    if (!isRecord(shot)) throw new Error("逐镜头 Studio 确认快照格式无效。");
    const subtitlesEnabled = requiredBoolean(shot.subtitles_enabled, "确认快照字幕开关格式无效。");
    const segments = shot.clip_segments === undefined || shot.clip_segments === null ? undefined : clipSegments(shot.clip_segments);
    return {
      shotId: requiredString(shot.shot_id, "确认快照缺少镜头标识。"),
      confirmationStatus: requiredConfirmationStatus(shot.confirmation_status),
      inputFingerprint: requiredString(shot.input_fingerprint, "确认快照缺少输入指纹。"),
      ...(shot.video_artifact_id === undefined || shot.video_artifact_id === null ? {} : { videoArtifactId: requiredString(shot.video_artifact_id, "确认快照缺少视频版本。") }),
      ...(shot.video_task_id === undefined || shot.video_task_id === null ? {} : { videoTaskId: requiredString(shot.video_task_id, "确认快照缺少视频任务版本。") }),
      ...(shot.source_material_revision_id === undefined || shot.source_material_revision_id === null ? {} : { sourceMaterialRevisionId: requiredString(shot.source_material_revision_id, "确认快照缺少原片版本。") }),
      ...(segments === undefined ? {} : { clipSegments: segments }),
      composition: shotComposition(shot.composition, segments?.length ?? 1),
      preparationContract: shotPreparationContract(shot.preparation_contract),
      audioMode: requiredAudioMode(shot.audio_mode),
      audioTrackId: shot.audio_track_id === null ? null : requiredString(shot.audio_track_id, "确认快照缺少音轨版本。"),
      subtitleText: requiredSubtitleText(shot.subtitle_text, subtitlesEnabled, "确认快照缺少字幕文本。"),
      subtitlesEnabled,
      ...(shot.duration_decision === undefined || shot.duration_decision === null ? {} : { durationDecision: shotDurationDecisionFromJson(shot.duration_decision) }),
    };
  });
}

function shotPreparationContract(value: unknown): ShotPreparationContract {
  if (!isRecord(value) || value.version !== "shot-preparation/v1") throw new Error("镜头准备契约格式无效。");
  const segments = clipSegments(value.clip_segments);
  const captions = shotCaptionContract(value.captions);
  const audioMode = requiredAudioMode(value.audio_mode);
  const audioMixCandidate = jsonKeysToCamel(value.audio_mix);
  const audioMix = normalizeShotAudioMix(audioMixCandidate, { audioMode, audioTrackId: value.audio_track_id === null ? null : typeof value.audio_track_id === "string" ? value.audio_track_id : null });
  if (!isValidShotAudioMix(audioMixCandidate) || audioMix.mainVoice.mode !== audioMode) throw new Error("镜头主声音与混音契约不一致。");
  return {
    version: "shot-preparation/v1",
    storyboardFingerprint: requiredString(value.storyboard_fingerprint, "镜头准备契约缺少分镜版本。"),
    sourceMaterialRevisionId: value.source_material_revision_id === null ? null : requiredString(value.source_material_revision_id, "镜头准备契约缺少原片版本。"),
    clipSegments: segments,
    composition: shotComposition(value.composition, segments.length),
    transitionMode: value.transition_mode === undefined ? "cut" : requiredShotTransitionMode(value.transition_mode),
    audioMode,
    ttsText: value.tts_text === null ? null : requiredString(value.tts_text, "镜头准备契约 TTS 正文格式无效。"),
    ttsVoice: value.tts_voice === null ? null : requiredString(value.tts_voice, "镜头准备契约 TTS 声音格式无效。"),
    ttsSpeakingRate: value.tts_speaking_rate === null ? null : requiredPositiveNumber(value.tts_speaking_rate, "镜头准备契约 TTS 语速格式无效。"),
    audioMix,
    captions,
    inputFingerprint: requiredString(value.input_fingerprint, "镜头准备契约缺少输入指纹。"),
  };
}

export function shotPreparationContractFromSnapshot(value: unknown): ShotPreparationContract {
  return shotPreparationContract(value);
}

function requiredShotTransitionMode(value: unknown): ShotTransitionMode {
  if (typeof value !== "string" || !shotTransitionModes.includes(value as ShotTransitionMode)) throw new Error("镜头准备契约衔接方式无效。");
  return value as ShotTransitionMode;
}

function jsonKeysToCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonKeysToCamel);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()), jsonKeysToCamel(entry)]));
}

function shotCaptionContract(value: unknown): ShotCaptionContract {
  if (!isRecord(value) || !isRecord(value.spatial) || !Array.isArray(value.cues)) throw new Error("镜头字幕契约格式无效。");
  const candidate = {
    version: value.version,
    enabled: value.enabled,
    contentMode: value.content_mode,
    text: value.text,
    cues: value.cues.map((cue) => isRecord(cue) ? { id: cue.id, text: cue.text, startMs: cue.start_ms, endMs: cue.end_ms } : cue),
    spatial: {
      version: value.spatial.version,
      anchor: value.spatial.anchor,
      safeArea: value.spatial.safe_area,
      ...(value.spatial.aspect_ratio === undefined ? {} : { aspectRatio: value.spatial.aspect_ratio }),
      ...(value.spatial.insets === undefined ? {} : { insets: value.spatial.insets }),
      maxLines: value.spatial.max_lines,
      maxCharactersPerLine: value.spatial.max_characters_per_line,
    },
  };
  const normalized = normalizeShotCaptionContract(candidate, { enabled: Boolean(value.enabled), text: typeof value.text === "string" ? value.text : "" });
  if (!isValidShotCaptionContract(normalized)) throw new Error("镜头字幕契约格式无效。");
  return normalized;
}

function shotComposition(value: unknown, clipSegmentCount: number): ShotComposition {
  if (value === undefined || value === null) return normalizeShotComposition(undefined, clipSegmentCount);
  if (!isValidShotComposition(value, Math.max(1, clipSegmentCount))) throw new Error("镜头结构化构图格式无效。");
  return value;
}

function clipSegments(value: unknown): Array<{ startSeconds: number; endSeconds: number }> {
  if (!Array.isArray(value) || value.length === 0) throw new Error("片段标记格式无效。");
  return value.map((segment) => {
    if (!isRecord(segment)) throw new Error("片段标记格式无效。");
    return { startSeconds: requiredNonNegativeNumber(segment.start_seconds, "片段标记缺少入点。"), endSeconds: requiredPositiveNumber(segment.end_seconds, "片段标记缺少出点。") };
  });
}

function requiredConfirmationMode(value: unknown): "shot_preparation" {
  if (value === "shot_preparation") return value;
  throw new Error("Studio 确认模式无效。");
}

function requiredConfirmationStatus(value: unknown): "confirmed" {
  if (value === "confirmed") return value;
  throw new Error("确认快照必须来自已确认镜头。");
}

function requiredAudioMode(value: unknown): "none" | "source" | "tts" {
  if (value === "none" || value === "source" || value === "tts") return value;
  throw new Error("Studio 音频模式无效。");
}

function requiredBoolean(value: unknown, message: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(message);
}

function studioProject(value: unknown): NonNullable<WorkerTaskPackageInput["reviewRender"]>["studioProject"] {
  if (!isRecord(value)) throw new Error("Studio 冻结工程格式无效。");
  const relativePath = requiredString(value.relative_path, "Studio 冻结工程缺少路径。");
  const sha256 = requiredString(value.sha256, "Studio 冻结工程缺少哈希。");
  const fileSize = requiredPositiveNumber(value.file_size, "Studio 冻结工程缺少文件大小。");
  if (!(/^(?:episodes\/[0-9a-f-]{36}\/studio-frozen\/[0-9a-f-]{36}\/index\.html|episodes\/[0-9a-f-]{36}\/openchatcut-frozen\/[0-9a-f-]{36}\/project\.json)$/i.test(relativePath)) || !/^[0-9a-f]{64}$/i.test(sha256)) throw new Error("Studio 冻结工程格式无效。");
  return { relativePath, sha256, fileSize };
}

function reviewRenderAdjustments(value: unknown): ReviewRenderAdjustments {
  if (!isRecord(value)) throw new Error("审核渲染任务缺少冻结合成配置。");
  const captionStyle = value.caption_style;
  const pacing = value.pacing;
  const crop = value.crop;
  const transition = value.transition;
  const layout = value.layout;
  const aspectRatio = value.aspect_ratio;
  const width = value.width;
  const height = value.height;
  const captionsEnabled = value.captions_enabled;
  const narrationGainDb = value.narration_gain_db;
  const bgmGainDb = value.bgm_gain_db;
  const sfxGainDb = value.sfx_gain_db;
  const frameRate = value.frame_rate === undefined ? defaultDurationFrameRate : value.frame_rate;
  const allowedFrames = value.allowed_frames === undefined ? defaultAllowedDurationFrames : value.allowed_frames;
  if ((aspectRatio !== "9:16" && aspectRatio !== "16:9" && aspectRatio !== "1:1") || typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || (aspectRatio === "9:16" && width * 16 !== height * 9) || (aspectRatio === "16:9" && width * 9 !== height * 16) || (aspectRatio === "1:1" && width !== height) || typeof captionsEnabled !== "boolean" || (captionStyle !== "cinematic" && captionStyle !== "minimal") || (pacing !== "gentle" && pacing !== "standard" && pacing !== "compact") || (crop !== "cover" && crop !== "contain") || (transition !== "fade" && transition !== "cut") || (layout !== "lower_third" && layout !== "center") || typeof narrationGainDb !== "number" || typeof bgmGainDb !== "number" || typeof sfxGainDb !== "number" || !Number.isFinite(narrationGainDb) || !Number.isFinite(bgmGainDb) || !Number.isFinite(sfxGainDb) || typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate <= 0 || typeof allowedFrames !== "number" || !Number.isInteger(allowedFrames) || allowedFrames < 0) throw new Error("审核渲染任务冻结合成配置无效。");
  return { aspectRatio, width, height, captionsEnabled, captionStyle, pacing, crop, transition, layout, narrationGainDb, bgmGainDb, sfxGainDb, frameRate, allowedFrames, reason: requiredString(value.reason, "审核渲染任务缺少调整理由。") };
}

function requiredReviewRenderMemberKind(value: unknown): "shot_media" | "narration" | "soundtrack" {
  if (value === "shot_media" || value === "narration" || value === "soundtrack") return value;
  throw new Error("审核渲染成员类型无效。");
}

function media(snapshot: Record<string, unknown>): WorkerTaskPackageInput["media"] {
  const value = snapshot.media;
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("媒体任务冻结配置格式无效。");
  if (value.adapter === "google_tts" || value.adapter === "volcengine_tts") {
    const narration = value.narration;
    if (!isRecord(narration) || !isRecord(narration.voice)) throw new Error("旁白任务冻结配置无效。");
    return {
      adapter: value.adapter,
      narration: {
        text: requiredString(narration.text, "旁白任务缺少冻结文本。"),
        voice: {
          languageCode: requiredString(narration.voice.language_code, "旁白任务缺少语言。"),
          name: requiredString(narration.voice.name, "旁白任务缺少声音。"),
          speakingRate: requiredPositiveNumber(narration.voice.speaking_rate, "旁白任务缺少有效语速。"),
        },
      },
    };
  }
  if (value.adapter === "pexels_video") {
    const bRoll = value.b_roll;
    if (!isRecord(bRoll) || !isRecord(bRoll.shot) || !Array.isArray(bRoll.shot.inputBasis)) throw new Error("B-roll 任务冻结配置无效。");
    return {
      adapter: "pexels_video",
      bRoll: {
        query: requiredString(bRoll.query, "B-roll 任务缺少冻结检索词。"),
        targetDurationSeconds: requiredPositiveNumber(bRoll.target_duration_seconds, "B-roll 任务缺少有效时长。"),
        shot: {
          id: requiredString(bRoll.shot.id, "B-roll 任务缺少镜头 ID。"),
          scriptSegment: requiredString(bRoll.shot.scriptSegment, "B-roll 任务缺少脚本片段。"),
          durationSeconds: requiredPositiveNumber(bRoll.shot.durationSeconds, "B-roll 任务缺少镜头时长。"),
          shotType: requiredShotType(bRoll.shot.shotType),
          productionMethod: requiredString(bRoll.shot.productionMethod, "B-roll 任务缺少制作方法。"),
          inputBasis: bRoll.shot.inputBasis.map((input) => {
            if (!isRecord(input)) throw new Error("B-roll 输入依据格式无效。");
            return { relativePath: requiredString(input.relativePath, "B-roll 输入依据缺少路径。"), sha256: requiredString(input.sha256, "B-roll 输入依据缺少哈希。") };
          }),
          targetSpec: requiredString(bRoll.shot.targetSpec, "B-roll 任务缺少目标规格。"),
        },
      },
    };
  }
  if (value.adapter === "openchatcut_card_video") {
    const cardVideo = value.card_video;
    if (!isRecord(cardVideo) || !isRecord(cardVideo.shot) || !Array.isArray(cardVideo.shot.inputBasis)) throw new Error("B-roll 卡片视频冻结配置无效。");
    return {
      adapter: "openchatcut_card_video",
      cardVideo: {
        shot: {
          id: requiredString(cardVideo.shot.id, "B-roll 卡片视频缺少镜头 ID。"),
          scriptSegment: requiredString(cardVideo.shot.scriptSegment, "B-roll 卡片视频缺少脚本片段。"),
          durationSeconds: requiredPositiveNumber(cardVideo.shot.durationSeconds, "B-roll 卡片视频缺少镜头时长。"),
          shotType: requiredShotType(cardVideo.shot.shotType),
          productionMethod: requiredString(cardVideo.shot.productionMethod, "B-roll 卡片视频缺少制作方法。"),
          inputBasis: cardVideo.shot.inputBasis.map((input) => {
            if (!isRecord(input)) throw new Error("B-roll 卡片视频输入依据格式无效。");
            return { relativePath: requiredString(input.relativePath, "B-roll 卡片视频输入依据缺少路径。"), sha256: requiredString(input.sha256, "B-roll 卡片视频输入依据缺少哈希。") };
          }),
          targetSpec: requiredString(cardVideo.shot.targetSpec, "B-roll 卡片视频缺少目标规格。"),
        },
      },
    };
  }
  if (value.adapter === "ffmpeg_extract_audio") {
    const embeddedAudio = value.embedded_audio;
    if (!isRecord(embeddedAudio)) throw new Error("派生音频任务冻结配置无效。");
    return {
      adapter: "ffmpeg_extract_audio",
      embeddedAudio: {
        sourceRelativePath: requiredString(embeddedAudio.source_relative_path, "派生音频任务缺少冻结视频路径。"),
        durationSeconds: requiredPositiveNumber(embeddedAudio.duration_seconds, "派生音频任务缺少有效时长。"),
      },
    };
  }
  if (value.adapter === "ffmpeg_trim_video") {
    const videoClip = value.video_clip;
    const videoClips = value.video_clips;
    if (!isRecord(videoClip) && !isRecord(videoClips)) throw new Error("镜头裁剪任务冻结配置无效。");
    if (isRecord(videoClips)) {
      if (!Array.isArray(videoClips.segments) || videoClips.segments.length === 0) throw new Error("镜头裁剪任务缺少冻结片段。");
      return {
        adapter: "ffmpeg_trim_video",
        videoClips: {
          sourceRelativePath: requiredString(videoClips.source_relative_path, "镜头裁剪任务缺少冻结视频路径。"),
          segments: videoClips.segments.map((segment) => {
            if (!isRecord(segment)) throw new Error("镜头裁剪任务片段格式无效。");
            return { startSeconds: requiredNonNegativeNumber(segment.start_seconds, "镜头裁剪任务缺少有效入点。"), endSeconds: requiredPositiveNumber(segment.end_seconds, "镜头裁剪任务缺少有效出点。") };
          }),
          targetDurationSeconds: requiredPositiveNumber(videoClips.target_duration_seconds, "镜头裁剪任务缺少有效总时长。"),
        },
      };
    }
    if (!isRecord(videoClip)) throw new Error("镜头裁剪任务冻结配置无效。");
    return {
      adapter: "ffmpeg_trim_video",
      videoClip: {
        sourceRelativePath: requiredString(videoClip.source_relative_path, "镜头裁剪任务缺少冻结视频路径。"),
        startSeconds: requiredNonNegativeNumber(videoClip.start_seconds, "镜头裁剪任务缺少有效入点。"),
        endSeconds: requiredPositiveNumber(videoClip.end_seconds, "镜头裁剪任务缺少有效出点。"),
        targetDurationSeconds: requiredPositiveNumber(videoClip.target_duration_seconds, "镜头裁剪任务缺少有效目标时长。"),
      },
    };
  }
  if (value.adapter === "freesound_preview") {
    const soundtrack = value.soundtrack;
    if (!isRecord(soundtrack) || !isRecord(soundtrack.cue)) throw new Error("声轨任务冻结配置无效。");
    return {
      adapter: "freesound_preview",
      soundtrack: {
        query: requiredString(soundtrack.query, "声轨任务缺少冻结检索词。"),
        targetDurationSeconds: requiredPositiveNumber(soundtrack.target_duration_seconds, "声轨任务缺少有效时长。"),
        cue: {
          id: requiredString(soundtrack.cue.id, "声轨任务缺少声轨 ID。"),
          kind: requiredSoundtrackKind(soundtrack.cue.kind),
          description: requiredString(soundtrack.cue.description, "声轨任务缺少声轨说明。"),
          searchQuery: requiredString(soundtrack.cue.search_query, "声轨任务缺少冻结检索词。"),
          startSeconds: requiredNonNegativeNumber(soundtrack.cue.start_seconds, "声轨任务缺少有效起始时间。"),
          durationSeconds: requiredPositiveNumber(soundtrack.cue.duration_seconds, "声轨任务缺少有效时长。"),
        },
      },
    };
  }
  throw new Error("媒体任务声明了不支持的适配器。");
}

function seriesBaseline(snapshot: Record<string, unknown>): WorkerTaskPackageInput["seriesBaseline"] {
  const value = snapshot.series_baseline;
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !isRecord(value.rules) || typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) throw new Error("任务系列基准格式无效。");
  return {
    versionId: requiredString(value.version_id, "任务系列基准缺少版本。"),
    version: value.version,
    rules: value.rules,
  };
}

function visualAssetPreparation(snapshot: Record<string, unknown>): WorkerTaskPackageInput["visualAssetPreparation"] {
  const value = snapshot.visual_assets;
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.external_inputs)) throw new Error("视觉资产准备冻结配置格式无效。");
  const imageGeneration = value.image_generation;
  if (imageGeneration === undefined || imageGeneration === null) return { externalInputs: value.external_inputs as ArtifactManifest[] };
  if (!isRecord(imageGeneration)) throw new Error("视觉资产准备图片 Adapter 格式无效。");
  return {
    externalInputs: value.external_inputs as ArtifactManifest[],
    imageGeneration: {
      provider: requiredString(imageGeneration.provider, "视觉资产准备图片 Adapter 缺少 Provider。"),
      adapter: requiredString(imageGeneration.adapter, "视觉资产准备图片 Adapter 缺少 Adapter。"),
      model: requiredString(imageGeneration.model, "视觉资产准备图片 Adapter 缺少模型。"),
      credentialRef: requiredString(imageGeneration.credential_ref, "视觉资产准备图片 Adapter 缺少外部连接。"),
    },
  };
}

function commission(snapshot: Record<string, unknown>): WorkerTaskPackageInput["commission"] {
  const value = snapshot.commission;
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("任务脚本委托格式无效。");
  return {
    creativeDirection: requiredString(value.creative_direction, "任务脚本委托缺少创作方向。"),
    coreContent: requiredString(value.core_content, "任务脚本委托缺少核心内容。"),
  };
}

function promptHarness(snapshot: Record<string, unknown>): WorkerTaskPackageInput["promptHarness"] {
  const value = snapshot.harness;
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.adapter !== "codex" || typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) throw new Error("任务 Prompt Harness 格式无效。");
  return {
    id: requiredString(value.id, "任务 Prompt Harness 缺少标识。"),
    version: value.version,
    content: requiredString(value.content, "任务 Prompt Harness 缺少冻结内容。"),
    contentHash: requiredString(value.content_hash, "任务 Prompt Harness 缺少内容哈希。"),
    adapter: "codex",
    model: requiredString(value.model, "任务 Prompt Harness 缺少模型。"),
    promptVersion: requiredString(value.prompt_version, "任务 Prompt Harness 缺少版本。"),
  };
}

function reviewFeedback(snapshot: Record<string, unknown>): WorkerTaskPackageInput["reviewFeedback"] {
  const value = snapshot.review_feedback;
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("任务审核反馈格式无效。");
  return {
    reviewPackageId: requiredString(value.review_package_id, "任务审核反馈缺少审核包。"),
    reason: requiredString(value.reason, "任务审核反馈缺少修改理由。"),
  };
}

function reviewAnnotations(snapshot: Record<string, unknown>): WorkerTaskPackageInput["reviewAnnotations"] {
  const value = snapshot.review_annotations;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("任务镜头批注格式无效。");
  return value.map((annotation) => {
    if (!isRecord(annotation)) throw new Error("任务镜头批注格式无效。");
    return {
      shotId: requiredString(annotation.shot_id, "任务镜头批注缺少镜头。"),
      reason: requiredString(annotation.reason, "任务镜头批注缺少内容。"),
    };
  });
}

function aRoll(snapshot: Record<string, unknown>): WorkerTaskPackageInput["aRoll"] {
  if (snapshot.capability !== "a_roll_generation") return undefined;
  const executor = snapshot.executor;
  const shot = snapshot.shot;
  if (!isRecord(executor) || !isRecord(shot)) throw new Error("A-roll 任务缺少冻结执行器或镜头。");
  const inputBasis = shot.inputBasis;
  if (!Array.isArray(inputBasis)) throw new Error("A-roll 任务缺少冻结镜头输入。");
  return {
    adapter: requiredString(executor.adapter, "A-roll 任务缺少冻结适配器。"),
    shot: {
      id: requiredString(shot.id, "A-roll 任务缺少镜头 ID。"),
      scriptSegment: requiredString(shot.scriptSegment, "A-roll 任务缺少脚本片段。"),
      durationSeconds: requiredPositiveNumber(shot.durationSeconds, "A-roll 任务缺少有效时长。"),
      shotType: requiredShotType(shot.shotType),
      productionMethod: requiredString(shot.productionMethod, "A-roll 任务缺少制作方法。"),
      inputBasis: inputBasis.map((input) => {
        if (!isRecord(input)) throw new Error("A-roll 任务的输入依据格式无效。");
        return { relativePath: requiredString(input.relativePath, "A-roll 输入依据缺少路径。"), sha256: requiredString(input.sha256, "A-roll 输入依据缺少哈希。") };
      }),
      targetSpec: requiredString(shot.targetSpec, "A-roll 任务缺少目标规格。"),
    },
  };
}

export function parseCodexOutput(output: string, actualCostCents: number): unknown {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) throw new Error("Codex 必须返回一个 JSON 对象。");
  return { ...parsed, actualCostCents };
}

function outputContract(snapshot: Record<string, unknown>): WorkerTaskPackageInput["output"] {
  const output = snapshot.output;
  if (!isRecord(output)) throw new Error("任务缺少输出产物 Schema。");
  return {
    requiredArtifactTypes: stringArray(output.required_artifact_types, "任务缺少输出产物 Schema。"),
    contentType: requiredString(output.content_type, "任务缺少输出内容类型。"),
    relativePath: requiredString(output.relative_path, "任务缺少冻结输出路径。"),
    reviewStage: requiredString(output.review_stage, "任务缺少输出审核阶段。"),
  };
}

function inputArtifacts(snapshot: Record<string, unknown>): ArtifactManifest[] {
  const artifacts = snapshot.input_artifacts;
  if (artifacts === undefined) return [];
  if (!Array.isArray(artifacts)) throw new Error("任务输入产物清单格式无效。");
  return artifacts as ArtifactManifest[];
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

function requiredSubtitleText(value: unknown, enabled: boolean, message: string): string {
  if (typeof value !== "string" || (enabled && !value.trim())) throw new Error(message);
  return value;
}

function requiredPositiveNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(message);
  return value;
}

function requiredNonNegativeNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(message);
  return value;
}

function requiredSoundtrackKind(value: unknown): "bgm" | "sfx" {
  if (value !== "bgm" && value !== "sfx") throw new Error("声轨任务类型无效。");
  return value;
}

function requiredShotType(value: unknown): "a_roll" | "b_roll" {
  if (value !== "a_roll" && value !== "b_roll") throw new Error("A-roll 任务镜头类型无效。");
  return value;
}

function stringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(message);
  return value as string[];
}

function createBlockedResult(taskId: string, actualCostCents: number, error: unknown, code = "task_package_invalid"): WorkerResult {
  return {
    version: "worker-result/v1",
    taskId,
    status: "blocked",
    artifacts: [],
    validation: { passed: false, checks: [] },
    actualCostCents,
    blockers: [{ code, detail: errorMessage(error) }],
    retry: { shouldRetry: false, reason: "Owner action is required before retrying this task." },
    nextStep: "Correct the task package and create a new task attempt.",
  };
}

function createPreflightResult(taskPackage: WorkerTaskPackage, actualCostCents: number, preflight: WorkerPreflightResult): WorkerResult {
  const failedChecks = preflight.checks.filter((check) => check.status !== "passed");
  const retryable = failedChecks.length > 0 && failedChecks.every((check) => check.status === "retryable" && check.action === "retry");
  const shouldRetry = retryable && taskPackage.budget.attempt + 1 < taskPackage.budget.maxAttempts;
  const reason = failedChecks.map((check) => check.reason).join("；");
  return {
    version: "worker-result/v1",
    taskId: taskPackage.task.id,
    status: retryable ? "failed" : "blocked",
    artifacts: [],
    validation: {
      passed: false,
      checks: preflight.checks.map((check) => ({ name: `preflight:${check.check}`, passed: check.status === "passed", detail: check.reason })),
    },
    preflight,
    actualCostCents,
    blockers: failedChecks.map((check) => preflightBlocker(check)),
    retry: { shouldRetry, reason },
    nextStep: shouldRetry ? "Retry the task after the temporary dependency failure recovers." : "Resolve the Worker preflight blocker before retrying this task.",
  };
}

function addPreflight(result: WorkerResult, preflight: WorkerPreflightResult | undefined): WorkerResult {
  return preflight ? { ...result, preflight } : result;
}

function appendPreflight(preflight: WorkerPreflightResult | undefined, check: WorkerPreflightCheck): WorkerPreflightResult {
  return { version: workerPreflightVersion, checks: [...(preflight?.checks ?? []), check] };
}

function preflightBlocker(check: WorkerPreflightCheck): NonNullable<WorkerResult["blockers"]>[number] {
  return {
    code: check.check,
    detail: check.reason,
    capability: check.capability,
    check: check.check,
    phase: check.phase,
    status: check.status,
    action: check.action,
    scope: check.scope,
  };
}

function createFailedResult(taskPackage: WorkerTaskPackage, actualCostCents: number, error: unknown): WorkerResult {
  return {
    version: "worker-result/v1",
    taskId: taskPackage.task.id,
    status: "failed",
    artifacts: [],
    validation: { passed: false, checks: [{ name: "codex_execution", passed: false, detail: errorMessage(error) }] },
    actualCostCents,
    blockers: [],
    retry: {
      shouldRetry: taskPackage.budget.attempt + 1 < taskPackage.budget.maxAttempts,
      reason: errorMessage(error),
    },
    nextStep: "Retry only after the reported failure is understood.",
  };
}

function executionPreflightCheck(taskPackage: WorkerTaskPackage, error: unknown): WorkerPreflightCheck | undefined {
  const detail = errorMessage(error);
  const imageGeneration = taskPackage.visualAssetPreparation?.imageGeneration;
  const isOpenAiStaticVisual = (taskPackage.provider === "openai" && taskPackage.media?.adapter === "openai_images") || (imageGeneration?.provider === "openai" && imageGeneration.adapter === "openai_images");
  const isCloudflareStaticVisual = (taskPackage.provider === "cloudflare" && taskPackage.media?.adapter === "workers_ai_images") || (imageGeneration?.provider === "cloudflare" && imageGeneration.adapter === "workers_ai_images");
  const managedAdapter = taskPackage.media?.adapter ?? taskPackage.aRoll?.adapter;
  const adapterResolution = registeredAdapters.resolve({ capability: taskPackage.capability, provider: taskPackage.provider, adapter: managedAdapter });
  const isManagedConnection = isOpenAiStaticVisual || isCloudflareStaticVisual || (adapterResolution.kind === "registered" && adapterResolution.choice.connection.kind === "owner_managed");
  const capability = isOpenAiStaticVisual || isCloudflareStaticVisual ? "static_visual_generation" : taskPackage.capability;
  if (isOpenAiStaticVisual && /HTTP (400|404)/i.test(detail)) {
    return { capability, check: "model_permission", phase: "execution", status: "unavailable", reason: detail, action: "edit_blueprint", scope: "blueprint" };
  }
  if (isCloudflareStaticVisual && /HTTP (400|404)|model.+(not found|unsupported)|模型.+(不存在|不支持)/i.test(detail)) {
    return { capability, check: "model_permission", phase: "execution", status: "unavailable", reason: detail, action: "edit_blueprint", scope: "blueprint" };
  }
  if (isOpenAiStaticVisual && /HTTP (401|403)|api[ _-]?key|credential|token|凭据|密钥|令牌/i.test(detail)) {
    return { capability, check: "credential_validity", phase: "execution", status: "unavailable", reason: detail, action: "manage_connection", scope: "connection" };
  }
  if (taskPackage.provider === "codex" && /model|permission|access denied|does not have access|not allowed|not supported|unauthorized|forbidden|模型|权限|无权|未授权|不支持/i.test(detail)) {
    return {
      capability: taskPackage.capability,
      check: "model_permission",
      phase: "execution",
      status: "unavailable",
      reason: detail,
      action: "contact_environment_admin",
      scope: "worker",
    };
  }
  if (isManagedConnection && /api[ _-]?key|credential|token|401|403|凭据|密钥|令牌/i.test(detail)) {
    return {
      capability: taskPackage.capability,
      check: "credential_validity",
      phase: "execution",
      status: "unavailable",
      reason: detail,
      action: "manage_connection",
      scope: "connection",
    };
  }
  if (/api[ _-]?key|credential|token|401|403|凭据|密钥|令牌/i.test(detail)) {
    return {
      capability: taskPackage.capability,
      check: "credential_validity",
      phase: "execution",
      status: "unavailable",
      reason: detail,
      action: "contact_environment_admin",
      scope: "worker",
    };
  }
  if (/fetch failed|network|timeout|timed out|econnreset|econnrefused|etimedout|socket|dns|connection|连接|网络|超时/i.test(detail)) {
    return {
      capability: taskPackage.capability,
      check: "network_connectivity",
      phase: "execution",
      status: "retryable",
      reason: detail,
      action: "retry",
      scope: "worker",
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown worker error.";
}
