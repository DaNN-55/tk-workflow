import { registeredAdapters } from "./registeredAdapters.js";
import type { StoryboardStructureRevision } from "./storyboardRevision.js";
import { isShotDurationDecision, type ShotDurationDecision } from "./durationDecision.js";
import { isValidShotComposition, normalizeShotComposition, shotCompositionTiming, shotTransitionModes, type ShotComposition, type ShotTransitionMode } from "../shotComposition.js";
import { isValidShotCaptionContract, type ShotCaptionContract } from "../shotCaptions.js";
import { isValidShotAudioMix, type ShotAudioMixContract } from "../shotAudioMix.js";
import { isValidAcousticAlignmentResult, type AcousticAlignmentResult } from "./acousticAlignmentContract.js";

export const workerTaskPackageVersion = "worker-task/v1" as const;
export const workerResultVersion = "worker-result/v1" as const;
export const workerPreflightVersion = "worker-preflight/v2" as const;
export type WorkerPreflightVersion = "worker-preflight/v1" | typeof workerPreflightVersion;
export const missingVisualAssetAdapterMessage = "视觉资产准备没有导入视觉素材，也没有已登记的图片 Adapter。";

export type WorkerResultStatus = "completed" | "blocked" | "failed";
export type WorkerPreflightPhase = "preflight" | "execution";
export type WorkerPreflightStatus = "passed" | "blocked" | "retryable" | "unavailable";
export type WorkerPreflightAction = "none" | "edit_blueprint" | "manage_connection" | "retry" | "contact_environment_admin";
export type WorkerPreflightScope = "blueprint" | "connection" | "episode" | "worker";

export interface WorkerPreflightCheck {
  adapter?: string;
  capability: string;
  check: string;
  phase: WorkerPreflightPhase;
  provider?: string;
  status: WorkerPreflightStatus;
  reason: string;
  action: WorkerPreflightAction;
  scope: WorkerPreflightScope;
}

export interface WorkerPreflightResult {
  version: WorkerPreflightVersion;
  checks: WorkerPreflightCheck[];
}

export interface PromptContextSnapshot {
  version: "prompt-context/v1";
  blueprintVersionId: string;
  seriesVersionId?: string;
  accountHardConstraints: unknown;
  accountDefaults: unknown;
  seriesBaseline?: unknown;
  episodeInput: unknown;
  reviewFeedback?: unknown;
  hash: string;
}

export interface PromptHarnessSnapshot {
  id: string;
  version: number;
  content: string;
  contentHash: string;
  adapter: "codex";
  model: string;
  promptVersion: string;
}

export interface ArtifactManifest {
  artifactType: string;
  relativePath: string;
  sha256: string;
  fileSize: number;
}

export interface VisualAssetRequest {
  id: string;
  prompt: string;
  inputBasis: Array<Pick<ArtifactManifest, "relativePath" | "sha256">>;
}

export interface StoryboardShotManifest {
  id: string;
  scriptSegment: string;
  durationSeconds: number;
  shotType: "a_roll" | "b_roll";
  productionMethod: string;
  inputBasis: Array<Pick<ArtifactManifest, "relativePath" | "sha256">>;
  targetSpec: string;
}

export interface StoryboardManifest {
  version: "storyboard/v1";
  shots: StoryboardShotManifest[];
  audioCues: StoryboardAudioCue[];
}

export interface StoryboardAudioCue {
  id: string;
  kind: "bgm" | "sfx";
  description: string;
  searchQuery: string;
  startSeconds: number;
  durationSeconds: number;
}

export interface ReviewRenderAdjustments {
  aspectRatio: "9:16" | "16:9" | "1:1";
  width: number;
  height: number;
  captionsEnabled: boolean;
  captionStyle: "cinematic" | "minimal";
  pacing: "gentle" | "standard" | "compact";
  crop: "cover" | "contain";
  transition: "fade" | "cut";
  layout: "lower_third" | "center";
  narrationGainDb: number;
  bgmGainDb: number;
  sfxGainDb: number;
  frameRate?: number;
  allowedFrames?: number;
  reason: string;
}

export interface ShotPreparationContract {
  version: "shot-preparation/v1";
  storyboardFingerprint: string;
  sourceMaterialRevisionId: string | null;
  clipSegments: Array<{ startSeconds: number; endSeconds: number }>;
  composition: ShotComposition;
  transitionMode: ShotTransitionMode;
  audioMode: "none" | "source" | "tts";
  ttsText: string | null;
  ttsVoice: string | null;
  ttsSpeakingRate: number | null;
  audioMix: ShotAudioMixContract;
  captions: ShotCaptionContract;
  inputFingerprint: string;
}

export interface WorkerTaskPackageInput {
  task: {
    id: string;
    type: string;
    attempt: number;
    budgetLimitCents: number;
    maxAttempts: number;
    provider: "codex" | "google_tts" | "volcengine_tts" | "pexels" | "ffmpeg" | "freesound" | "openchatcut" | "openai" | "cloudflare" | "whisperx";
    model: string;
    promptVersion: string;
  };
  episode: {
    id: string;
    accountId: string;
    blueprintVersionId: string;
    title: string;
  };
  capability: string;
  credentialRef?: string;
  acousticAlignment?: {
    confirmedText: string;
    textFingerprint: string;
    audioRelativePath?: string;
    audioSha256?: string;
    inputVersion?: string;
    speakingRate?: number;
    strategy?: "auto" | "local";
    voice?: string;
  };
  promptContext?: PromptContextSnapshot;
  promptHarness?: PromptHarnessSnapshot;
  commission?: {
    creativeDirection: string;
    coreContent: string;
  };
  seriesBaseline?: {
    versionId: string;
    version: number;
    rules: unknown;
  };
  visualAssetPreparation?: {
    externalInputs: ArtifactManifest[];
    imageGeneration?: {
      provider: string;
      adapter: string;
      model: string;
      credentialRef: string;
    };
  };
  reviewFeedback?: {
    reviewPackageId: string;
    reason: string;
  };
  reviewAnnotations?: Array<{
    shotId: string;
    reason: string;
  }>;
  storyboardRevision?: StoryboardStructureRevision;
  aRoll?: {
    adapter: string;
    shot: StoryboardShotManifest;
  };
  media?:
    | {
      adapter: "google_tts" | "volcengine_tts";
      narration: {
        text: string;
        voice: GoogleTtsVoice;
      };
    }
    | {
      adapter: "pexels_video";
      bRoll: {
        query: string;
        targetDurationSeconds: number;
        shot: StoryboardShotManifest;
      };
    }
    | {
      adapter: "openchatcut_card_video";
      cardVideo: {
        shot: StoryboardShotManifest;
      };
    }
    | {
      adapter: "ffmpeg_extract_audio";
      embeddedAudio: {
        sourceRelativePath: string;
        durationSeconds: number;
      };
    }
    | {
      adapter: "ffmpeg_trim_video";
      videoClip?: {
        sourceRelativePath: string;
        startSeconds: number;
        endSeconds: number;
        targetDurationSeconds: number;
      };
      videoClips?: {
        sourceRelativePath: string;
        segments: Array<{ startSeconds: number; endSeconds: number }>;
        targetDurationSeconds: number;
      };
    }
    | {
      adapter: "freesound_preview";
      soundtrack: {
        query: string;
        targetDurationSeconds: number;
        cue: StoryboardAudioCue;
      };
    }
    | {
      adapter: "openai_images" | "workers_ai_images";
      staticVisual: {
        prompt: string;
      };
    };
  reviewRender?: {
    projectRelativePath: string;
    projectRevision: number;
    compositionId?: string;
    preRenderReviewPackageId: string;
    confirmationMode: "shot_preparation";
    confirmedShots: Array<{
      shotId: string;
      confirmationStatus: "confirmed";
      inputFingerprint: string;
      videoArtifactId?: string;
      videoTaskId?: string;
      sourceMaterialRevisionId?: string;
      clipSegments?: Array<{ startSeconds: number; endSeconds: number }>;
      composition?: ShotComposition;
      preparationContract: ShotPreparationContract;
      audioMode: "none" | "source" | "tts";
      audioTrackId: string | null;
      subtitleText: string;
      subtitlesEnabled: boolean;
      durationDecision?: ShotDurationDecision;
    }>;
    studioProject?: {
      relativePath: string;
      sha256: string;
      fileSize: number;
    };
    studioProjectRevision?: string;
    adjustments: ReviewRenderAdjustments;
    storyboard: StoryboardManifest;
    members: Array<{
      memberKey: string;
      memberKind: "shot_media" | "narration" | "soundtrack";
      mediaMissing?: boolean;
      audioKind?: "bgm" | "sfx";
      taskId?: string;
      artifactId?: string;
      sourceMaterialRevisionId?: string;
      clipSegments?: Array<{ startSeconds: number; endSeconds: number }>;
      composition?: ShotComposition;
      preparationContract?: ShotPreparationContract;
      audioTrackId?: string | null;
      inputFingerprint?: string;
      audioMode?: "none" | "source" | "tts";
      subtitleText?: string;
      subtitlesEnabled?: boolean;
      relativePath: string;
      sha256: string;
      startSeconds: number;
      durationSeconds: number;
      durationDecision?: ShotDurationDecision;
    }>;
  };
  finalRender?: {
    sourceReviewPackageId: string;
    sourceProject: ArtifactManifest;
    sourceRuntime: ArtifactManifest;
    sourceQcReport: ArtifactManifest;
    projectRelativePath: string;
    projectRevision: number;
    reviewRender: NonNullable<WorkerTaskPackageInput["reviewRender"]>;
  };
  allowedTools: string[];
  allowedAssetRoot: string;
  output: {
    requiredArtifactTypes: string[];
    contentType: string;
    relativePath: string;
    reviewStage: string;
  };
  inputArtifacts: ArtifactManifest[];
}

export interface WorkerTaskPackage {
  version: typeof workerTaskPackageVersion;
  provider: WorkerTaskPackageInput["task"]["provider"];
  model: string;
  promptVersion: string;
  capability: string;
  credentialRef?: string;
  acousticAlignment?: WorkerTaskPackageInput["acousticAlignment"];
  promptContext?: PromptContextSnapshot;
  promptHarness?: PromptHarnessSnapshot;
  commission?: {
    creativeDirection: string;
    coreContent: string;
  };
  seriesBaseline?: {
    versionId: string;
    version: number;
    rules: unknown;
  };
  visualAssetPreparation?: WorkerTaskPackageInput["visualAssetPreparation"];
  reviewFeedback?: {
    reviewPackageId: string;
    reason: string;
  };
  reviewAnnotations?: ReadonlyArray<{
    shotId: string;
    reason: string;
  }>;
  storyboardRevision?: StoryboardStructureRevision;
  aRoll?: {
    adapter: string;
    shot: StoryboardShotManifest;
  };
  media?: WorkerTaskPackageInput["media"];
  reviewRender?: WorkerTaskPackageInput["reviewRender"];
  finalRender?: WorkerTaskPackageInput["finalRender"];
  allowedTools: readonly string[];
  task: Pick<WorkerTaskPackageInput["task"], "id" | "type">;
  accountId: string;
  episode: WorkerTaskPackageInput["episode"];
  assets: {
    allowedRoot: string;
    inputs: ArtifactManifest[];
  };
  output: {
    requiredArtifactTypes: readonly string[];
    contentType: string;
    relativePath: string;
    reviewStage: string;
  };
  budget: {
    limitCents: number;
    maxAttempts: number;
    attempt: number;
  };
  forbiddenActions: readonly ["approve", "publish", "change_blueprint", "change_episode_stage"];
}

export interface GoogleTtsVoice {
  languageCode: string;
  name: string;
  speakingRate: number;
}

export interface WorkerResult {
  version: typeof workerResultVersion;
  taskId: string;
  status: WorkerResultStatus;
  artifacts: ArtifactManifest[];
  storyboard?: StoryboardManifest;
  visualAssetRequests?: VisualAssetRequest[];
  validation: {
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
  };
  preflight?: WorkerPreflightResult;
  actualCostCents: number;
  audioDurationSeconds?: number;
  acousticAlignment?: AcousticAlignmentResult;
  mediaSource?: {
    provider: "freesound";
    sourceId: number;
    title: string;
    creator: string;
    license: string;
    sourceUrl: string;
    previewUrl: string;
  };
  blockers: Array<{
    code: string;
    detail: string;
    capability?: string;
    check?: string;
    phase?: WorkerPreflightPhase;
    status?: WorkerPreflightStatus;
    action?: WorkerPreflightAction;
    scope?: WorkerPreflightScope;
  }>;
  retry: {
    shouldRetry: boolean;
    reason: string;
  };
  nextStep: string;
}

const forbiddenActions = ["approve", "publish", "change_blueprint", "change_episode_stage"] as const;

export function createWorkerTaskPackage(input: WorkerTaskPackageInput): WorkerTaskPackage {
  if (!input.allowedAssetRoot.trim()) throw new Error("allowedAssetRoot is required.");
  if (!Number.isInteger(input.task.budgetLimitCents) || input.task.budgetLimitCents < 0) throw new Error("budgetLimitCents must be a non-negative integer.");
  if (!Number.isInteger(input.task.maxAttempts) || input.task.maxAttempts < 1) throw new Error("maxAttempts must be a positive integer.");
  if (!Number.isInteger(input.task.attempt) || input.task.attempt < 0 || input.task.attempt >= input.task.maxAttempts) throw new Error("attempt must be lower than maxAttempts.");
  if (!input.task.model.trim() || !input.task.promptVersion.trim()) throw new Error("model and promptVersion are required.");
  if (!isNonEmptyString(input.task.type)) throw new Error("task type is required.");
  if (!isNonEmptyString(input.capability)) throw new Error("capability is required.");
  if (input.promptContext && (!isNonEmptyString(input.promptContext.blueprintVersionId) || input.promptContext.version !== "prompt-context/v1" || !isNonEmptyString(input.promptContext.hash) || !isRecord(input.promptContext.accountHardConstraints) || !isRecord(input.promptContext.accountDefaults) || !isRecord(input.promptContext.episodeInput))) throw new Error("promptContext must contain a frozen version, hash, and context objects.");
  if (input.promptHarness && (!isNonEmptyString(input.promptHarness.id) || !Number.isInteger(input.promptHarness.version) || input.promptHarness.version < 1 || !isNonEmptyString(input.promptHarness.content) || !/^[0-9a-f]{64}$/.test(input.promptHarness.contentHash) || input.promptHarness.adapter !== "codex" || !isNonEmptyString(input.promptHarness.model) || !isNonEmptyString(input.promptHarness.promptVersion))) throw new Error("promptHarness must contain a frozen Codex harness and content hash.");
  if (input.capability === "storyboard_planning" && !input.promptHarness) throw new Error("分镜规划必须包含冻结的 Codex Adapter 与 Prompt Harness。");
  if (input.commission && (!isNonEmptyString(input.commission.creativeDirection) || !isNonEmptyString(input.commission.coreContent))) throw new Error("commission must contain creative direction and core content.");
  if (input.seriesBaseline && (!isNonEmptyString(input.seriesBaseline.versionId) || !Number.isInteger(input.seriesBaseline.version) || input.seriesBaseline.version < 1 || !isRecord(input.seriesBaseline.rules))) throw new Error("seriesBaseline must contain a version and rule object.");
  if (input.visualAssetPreparation) {
    if (input.capability !== "visual_planning") throw new Error("只有视觉资产准备任务可以声明视觉输入。");
    input.visualAssetPreparation.externalInputs.forEach(assertArtifactManifest);
    const imageGeneration = input.visualAssetPreparation.imageGeneration;
    if (imageGeneration && (!isNonEmptyString(imageGeneration.provider) || !isNonEmptyString(imageGeneration.adapter) || !isNonEmptyString(imageGeneration.model) || !isConnectionId(imageGeneration.credentialRef))) throw new Error("图片 Adapter 配置无效，必须使用连接版本 ID。");
    if (input.visualAssetPreparation.externalInputs.length === 0 && (!imageGeneration || registeredAdapters.resolve({ capability: "static_visual_generation", provider: imageGeneration.provider, adapter: imageGeneration.adapter }).kind !== "registered")) {
      throw new Error(missingVisualAssetAdapterMessage);
    }
  }
  if (input.reviewFeedback && (!isNonEmptyString(input.reviewFeedback.reviewPackageId) || !isNonEmptyString(input.reviewFeedback.reason))) throw new Error("review feedback must contain its package and reason.");
  if (input.reviewAnnotations?.some((annotation) => !isNonEmptyString(annotation.shotId) || !isNonEmptyString(annotation.reason))) throw new Error("review annotations must contain a shot and reason.");
  if (input.capability === "a_roll_generation" && !input.aRoll) throw new Error("a-roll generation requires its frozen adapter and shot.");
  if (input.capability !== "a_roll_generation" && input.aRoll) throw new Error("only a-roll generation may include a frozen shot.");
  if (input.aRoll) {
    if (!isNonEmptyString(input.aRoll.adapter)) throw new Error("a-roll generation requires an adapter.");
    if (input.aRoll.adapter === "openchatcut_card_video" && input.task.provider !== "openchatcut") throw new Error("A-roll 卡片视频任务 Provider 必须是 OpenChatCut。");
    validateStoryboardManifest({ version: "storyboard/v1", shots: [input.aRoll.shot] }, input.inputArtifacts);
  }
  if (input.capability === "narration_generation" && (!input.media || (input.media.adapter !== "google_tts" && input.media.adapter !== "volcengine_tts"))) throw new Error("旁白生成必须包含冻结的 TTS 配置。");
  if (input.capability === "narration_generation" && !isConnectionId(input.credentialRef)) throw new Error("旁白生成必须包含冻结的外部连接版本 ID。");
  if (input.acousticAlignment && (!isNonEmptyString(input.acousticAlignment.confirmedText) || !isSha256(input.acousticAlignment.textFingerprint))) throw new Error("声学对齐必须冻结 Owner 字幕正文及其版本。");
  if (input.acousticAlignment?.audioRelativePath && !isSafeRelativePath(input.acousticAlignment.audioRelativePath)) throw new Error("声学对齐音频路径必须位于资产根目录内。");
  if (input.acousticAlignment?.audioSha256 !== undefined && !isSha256(input.acousticAlignment.audioSha256)) throw new Error("声学对齐音频哈希无效。");
  if (input.acousticAlignment?.inputVersion !== undefined && !isSha256(input.acousticAlignment.inputVersion)) throw new Error("声学对齐输入版本无效。");
  if (input.acousticAlignment?.speakingRate !== undefined && !isPositiveFiniteNumber(input.acousticAlignment.speakingRate)) throw new Error("声学对齐语速无效。");
  if (input.capability !== "narration_generation" && input.capability !== "acoustic_alignment" && input.acousticAlignment) throw new Error("只有旁白生成或独立字幕对齐任务可以冻结声学对齐输入。");
  if (input.capability === "acoustic_alignment" && (!input.acousticAlignment?.audioRelativePath || !isSha256(input.acousticAlignment.audioSha256) || !isSha256(input.acousticAlignment.inputVersion))) throw new Error("独立字幕对齐任务必须冻结音频路径、哈希与输入版本。");
  if (input.capability === "acoustic_alignment" && input.task.provider !== "whisperx") throw new Error("独立字幕对齐任务必须使用本地 WhisperX Provider。");
  if (input.capability === "b_roll_generation" && (!input.media || (input.media.adapter !== "pexels_video" && input.media.adapter !== "openchatcut_card_video"))) throw new Error("B-roll 生成必须包含冻结的媒体配置。");
  if (input.capability === "b_roll_generation" && input.media?.adapter === "pexels_video" && !isConnectionId(input.credentialRef)) throw new Error("B-roll 生成必须包含冻结的外部连接版本 ID。");
  if (input.credentialRef !== undefined && !isNonEmptyString(input.credentialRef)) throw new Error("外部连接引用格式无效。");
  if (input.capability === "embedded_audio_extraction" && (!input.media || input.media.adapter !== "ffmpeg_extract_audio")) throw new Error("派生音频提取必须包含冻结的视频输入。");
  if (input.capability === "shot_clip_preparation" && (!input.media || input.media.adapter !== "ffmpeg_trim_video")) throw new Error("镜头裁剪任务必须包含冻结的视频输入。");
  if (input.capability === "soundtrack_generation" && (input.task.provider !== "freesound" || !input.media || input.media.adapter !== "freesound_preview")) throw new Error("声轨生成必须包含冻结的 Freesound 配置。");
  if (input.capability === "soundtrack_generation" && !isConnectionId(input.credentialRef)) throw new Error("声轨生成必须包含冻结的外部连接版本 ID。");
  if (input.capability === "static_visual_generation" && (!input.media || (input.media.adapter !== "openai_images" && input.media.adapter !== "workers_ai_images"))) throw new Error("静态视觉生成必须包含冻结的图片 Adapter 配置。");
  if (input.capability === "static_visual_generation" && !isConnectionId(input.credentialRef)) throw new Error("静态视觉生成必须包含冻结的外部连接版本 ID。");
  if (input.capability === "review_rendering" && !input.reviewRender) throw new Error("审核渲染必须包含冻结的合成工程。 ");
  if (input.capability !== "review_rendering" && input.reviewRender) throw new Error("只有审核渲染任务可以包含合成工程。 ");
  if (input.capability === "final_rendering" && !input.finalRender) throw new Error("最终渲染必须包含冻结的审核工程。 ");
  if (input.capability !== "final_rendering" && input.finalRender) throw new Error("只有最终渲染任务可以包含冻结的审核工程。 ");
  if (input.reviewRender) {
    if (input.task.provider !== "openchatcut") throw new Error("审核渲染任务 Provider 必须是 OpenChatCut。 ");
    const render = input.reviewRender;
    if (!isSafeRelativePath(render.projectRelativePath) || !isNonEmptyString(render.preRenderReviewPackageId) || !Number.isInteger(render.projectRevision) || render.projectRevision < 1 || render.members.length === 0) throw new Error("冻结审核渲染工程格式无效。 ");
    if (render.studioProject && (!isSafeRelativePath(render.studioProject.relativePath) || !new RegExp(`^episodes/${input.episode.id}/(?:studio-frozen/[0-9a-f-]{36}/index\\.html|openchatcut-frozen/[0-9a-f-]{36}/project\\.json)$`, "i").test(render.studioProject.relativePath) || !isSha256(render.studioProject.sha256) || !Number.isInteger(render.studioProject.fileSize) || render.studioProject.fileSize < 1)) throw new Error("OpenChatCut 冻结工程格式无效。 ");
    validateReviewRenderStoryboard(render.storyboard);
    if (!isReviewRenderAdjustments(render.adjustments)) throw new Error("冻结审核渲染合成配置无效。 ");
    for (const member of render.members) {
      if (!isNonEmptyString(member.memberKey) || (member.memberKind !== "shot_media" && member.memberKind !== "narration" && member.memberKind !== "soundtrack") || (member.audioKind !== undefined && member.audioKind !== "bgm" && member.audioKind !== "sfx") || (member.taskId !== undefined && !isNonEmptyString(member.taskId)) || (member.artifactId !== undefined && !isNonEmptyString(member.artifactId)) || (member.audioTrackId !== undefined && member.audioTrackId !== null && !isNonEmptyString(member.audioTrackId)) || (member.audioMode !== undefined && member.audioMode !== "none" && member.audioMode !== "source" && member.audioMode !== "tts") || (member.subtitleText !== undefined && typeof member.subtitleText !== "string") || (member.subtitlesEnabled !== undefined && typeof member.subtitlesEnabled !== "boolean") || (member.composition !== undefined && !isValidShotComposition(member.composition, Math.max(1, member.clipSegments?.length ?? 1))) || (member.preparationContract !== undefined && !isValidShotPreparationContract(member.preparationContract)) || !isSafeRelativePath(member.relativePath) || !isSha256(member.sha256) || !isNonNegativeNumber(member.startSeconds) || !isPositiveFiniteNumber(member.durationSeconds) || !input.inputArtifacts.some((artifact) => artifact.relativePath === member.relativePath && artifact.sha256 === member.sha256)) throw new Error("冻结审核渲染成员格式无效。 ");
    }
    if (render.confirmationMode !== "shot_preparation") throw new Error("OpenChatCut 新工程只接受版本化镜头准备契约。 ");
    validateConfirmedShotPreparationRender(render);
  }
  if (input.finalRender) {
    const finalRender = input.finalRender;
    if (input.task.provider !== "openchatcut" || !isNonEmptyString(finalRender.sourceReviewPackageId) || !isSafeRelativePath(finalRender.projectRelativePath) || !Number.isInteger(finalRender.projectRevision) || finalRender.projectRevision < 1) throw new Error("冻结最终渲染工程格式无效。 ");
    assertArtifactManifest(finalRender.sourceProject);
    assertArtifactManifest(finalRender.sourceRuntime);
    assertArtifactManifest(finalRender.sourceQcReport);
    if (finalRender.sourceProject.artifactType !== "review_render_project" || finalRender.sourceRuntime.artifactType !== "review_render_runtime" || finalRender.sourceQcReport.artifactType !== "review_qc_report") throw new Error("最终渲染必须引用审核工程、运行时和 QC 报告。 ");
    if (!input.inputArtifacts.some((artifact) => artifact.relativePath === finalRender.sourceProject.relativePath && artifact.sha256 === finalRender.sourceProject.sha256)
      || !input.inputArtifacts.some((artifact) => artifact.relativePath === finalRender.sourceRuntime.relativePath && artifact.sha256 === finalRender.sourceRuntime.sha256)
      || !input.inputArtifacts.some((artifact) => artifact.relativePath === finalRender.sourceQcReport.relativePath && artifact.sha256 === finalRender.sourceQcReport.sha256)) throw new Error("最终渲染引用未冻结的审核证据。 ");
    const source = finalRender.reviewRender;
    if (source.projectRelativePath !== finalRender.sourceProject.relativePath || source.projectRevision !== finalRender.projectRevision || !isNonEmptyString(source.preRenderReviewPackageId) || source.members.length === 0) throw new Error("最终渲染冻结工程不一致。 ");
    if (source.confirmationMode !== "shot_preparation") throw new Error("OpenChatCut 最终渲染只接受版本化镜头准备契约。 ");
    validateConfirmedShotPreparationRender(source);
  }
  if (input.media?.adapter === "google_tts" || input.media?.adapter === "volcengine_tts") {
    if (input.task.provider !== input.media.adapter) throw new Error("旁白任务 Provider 必须与冻结 TTS 适配器匹配。");
    const { narration } = input.media;
    if (!isNonEmptyString(narration.text) || !isNonEmptyString(narration.voice.languageCode) || !isNonEmptyString(narration.voice.name) || !isPositiveFiniteNumber(narration.voice.speakingRate)) throw new Error("旁白任务的冻结文本或声音无效。");
  }
  if (input.media?.adapter === "pexels_video") {
    if (input.task.provider !== "pexels") throw new Error("B-roll 任务 Provider 必须与冻结 Pexels 适配器匹配。");
    const { bRoll } = input.media;
    if (!isNonEmptyString(bRoll.query) || !isPositiveFiniteNumber(bRoll.targetDurationSeconds)) throw new Error("B-roll 任务的冻结检索词或时长无效。");
    validateStoryboardManifest({ version: "storyboard/v1", shots: [bRoll.shot] }, input.inputArtifacts);
  }
  if (input.media?.adapter === "openchatcut_card_video") {
    if (input.task.provider !== "openchatcut") throw new Error("B-roll 卡片视频任务 Provider 必须是 OpenChatCut。");
    validateStoryboardManifest({ version: "storyboard/v1", shots: [input.media.cardVideo.shot] }, input.inputArtifacts);
  }
  if (input.media?.adapter === "ffmpeg_extract_audio") {
    if (input.task.provider !== "ffmpeg") throw new Error("派生音频任务 Provider 必须与冻结 ffmpeg 适配器匹配。");
    const embeddedAudio = input.media.embeddedAudio;
    if (!isSafeRelativePath(embeddedAudio.sourceRelativePath) || !isPositiveFiniteNumber(embeddedAudio.durationSeconds)) throw new Error("派生音频任务的冻结视频输入或时长无效。");
    if (!input.inputArtifacts.some((artifact) => artifact.relativePath === embeddedAudio.sourceRelativePath)) throw new Error("派生音频任务的视频输入未冻结。");
  }
  if (input.media?.adapter === "ffmpeg_trim_video") {
    if (input.task.provider !== "ffmpeg") throw new Error("镜头裁剪任务 Provider 必须与冻结 ffmpeg 适配器匹配。");
    const sources = [input.media.videoClip?.sourceRelativePath, input.media.videoClips?.sourceRelativePath].filter((value): value is string => Boolean(value));
    const clip = input.media.videoClip;
    const segments = input.media.videoClips?.segments;
    if (sources.length !== 1 || !isSafeRelativePath(sources[0]) || !input.inputArtifacts.some((artifact) => artifact.relativePath === sources[0])) throw new Error("镜头裁剪任务的视频输入未冻结。");
    if (clip && (!isNonNegativeNumber(clip.startSeconds) || !isPositiveFiniteNumber(clip.endSeconds) || clip.endSeconds <= clip.startSeconds || !isPositiveFiniteNumber(clip.targetDurationSeconds))) throw new Error("镜头裁剪任务的冻结区间无效。");
    if (segments && (segments.length === 0 || segments.some((segment) => !isNonNegativeNumber(segment.startSeconds) || !isPositiveFiniteNumber(segment.endSeconds) || segment.endSeconds <= segment.startSeconds))) throw new Error("镜头裁剪任务的冻结区间无效。");
    if (input.media.videoClips && !isPositiveFiniteNumber(input.media.videoClips.targetDurationSeconds)) throw new Error("镜头裁剪任务的冻结总时长无效。");
  }
  if (input.media?.adapter === "freesound_preview") {
    if (input.task.provider !== "freesound") throw new Error("声轨任务 Provider 必须与冻结 Freesound 适配器匹配。");
    const soundtrack = input.media.soundtrack;
    if (!isNonEmptyString(soundtrack.query) || soundtrack.query.length > 100 || !isPositiveFiniteNumber(soundtrack.targetDurationSeconds)) throw new Error("声轨任务的冻结检索词或时长无效。");
    validateStoryboardAudioCue(soundtrack.cue);
  }
  if (input.media?.adapter === "openai_images") {
    if (input.task.provider !== "openai" || !isConnectionId(input.credentialRef) || !isNonEmptyString(input.media.staticVisual.prompt)) throw new Error("静态视觉任务的冻结 OpenAI Images 配置无效，必须使用连接版本 ID。");
  }
  if (input.media?.adapter === "workers_ai_images") {
    if (input.task.provider !== "cloudflare" || !isConnectionId(input.credentialRef) || !isNonEmptyString(input.media.staticVisual.prompt)) throw new Error("静态视觉任务的冻结 Cloudflare Workers AI 配置无效，必须使用连接版本 ID。");
  }
  if (input.allowedTools.some((tool) => !isNonEmptyString(tool))) throw new Error("allowedTools must contain non-empty names.");
  if (input.output.requiredArtifactTypes.length === 0 || input.output.requiredArtifactTypes.some((artifactType) => !isNonEmptyString(artifactType))) throw new Error("至少需要一个输出产物类型。");
  if (!isNonEmptyString(input.output.contentType) || !isNonEmptyString(input.output.reviewStage) || !isSafeRelativePath(input.output.relativePath)) throw new Error("输出契约缺少有效的内容类型、路径或审核阶段。");

  input.inputArtifacts.forEach(assertArtifactManifest);

  return {
    version: workerTaskPackageVersion,
    provider: input.task.provider,
    model: input.task.model,
    promptVersion: input.task.promptVersion,
    capability: input.capability,
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
    ...(input.acousticAlignment ? { acousticAlignment: { ...input.acousticAlignment } } : {}),
    ...(input.promptContext ? { promptContext: { ...input.promptContext } } : {}),
    ...(input.promptHarness ? { promptHarness: { ...input.promptHarness } } : {}),
    ...(input.commission ? { commission: { creativeDirection: input.commission.creativeDirection, coreContent: input.commission.coreContent } } : {}),
    ...(input.seriesBaseline ? { seriesBaseline: { versionId: input.seriesBaseline.versionId, version: input.seriesBaseline.version, rules: input.seriesBaseline.rules } } : {}),
    ...(input.visualAssetPreparation ? { visualAssetPreparation: { externalInputs: input.visualAssetPreparation.externalInputs.map((artifact) => ({ ...artifact })), ...(input.visualAssetPreparation.imageGeneration ? { imageGeneration: { ...input.visualAssetPreparation.imageGeneration } } : {}) } } : {}),
    ...(input.reviewFeedback ? { reviewFeedback: { reviewPackageId: input.reviewFeedback.reviewPackageId, reason: input.reviewFeedback.reason } } : {}),
    ...(input.reviewAnnotations?.length ? { reviewAnnotations: input.reviewAnnotations.map((annotation) => ({ shotId: annotation.shotId, reason: annotation.reason })) } : {}),
    ...(input.storyboardRevision ? { storyboardRevision: input.storyboardRevision } : {}),
    ...(input.aRoll ? { aRoll: { adapter: input.aRoll.adapter, shot: input.aRoll.shot } } : {}),
    ...(input.media ? { media: input.media } : {}),
    ...(input.reviewRender ? { reviewRender: { ...input.reviewRender, ...(input.reviewRender.studioProject ? { studioProject: { ...input.reviewRender.studioProject } } : {}), members: input.reviewRender.members.map((member) => ({ ...member })) } } : {}),
    ...(input.finalRender ? { finalRender: { ...input.finalRender, sourceProject: { ...input.finalRender.sourceProject }, sourceRuntime: { ...input.finalRender.sourceRuntime }, sourceQcReport: { ...input.finalRender.sourceQcReport }, reviewRender: { ...input.finalRender.reviewRender, members: input.finalRender.reviewRender.members.map((member) => ({ ...member })) } } } : {}),
    allowedTools: [...new Set(input.allowedTools)],
    task: { id: input.task.id, type: input.task.type },
    accountId: input.episode.accountId,
    episode: input.episode,
    assets: { allowedRoot: input.allowedAssetRoot, inputs: input.inputArtifacts },
    output: { requiredArtifactTypes: [...new Set(input.output.requiredArtifactTypes)], contentType: input.output.contentType, relativePath: input.output.relativePath, reviewStage: input.output.reviewStage },
    budget: { limitCents: input.task.budgetLimitCents, maxAttempts: input.task.maxAttempts, attempt: input.task.attempt },
    forbiddenActions,
  };
}

function isReviewRenderAdjustments(value: ReviewRenderAdjustments): boolean {
  return (value.aspectRatio === "9:16" || value.aspectRatio === "16:9" || value.aspectRatio === "1:1")
    && Number.isInteger(value.width) && Number.isInteger(value.height) && value.width > 0 && value.height > 0
    && ((value.aspectRatio === "9:16" && value.width * 16 === value.height * 9) || (value.aspectRatio === "16:9" && value.width * 9 === value.height * 16) || (value.aspectRatio === "1:1" && value.width === value.height))
    && typeof value.captionsEnabled === "boolean"
    && (value.captionStyle === "cinematic" || value.captionStyle === "minimal")
    && (value.pacing === "gentle" || value.pacing === "standard" || value.pacing === "compact")
    && (value.crop === "cover" || value.crop === "contain")
    && (value.transition === "fade" || value.transition === "cut")
    && (value.layout === "lower_third" || value.layout === "center")
    && Number.isFinite(value.narrationGainDb) && Number.isFinite(value.bgmGainDb) && Number.isFinite(value.sfxGainDb)
    && (value.frameRate === undefined || (Number.isFinite(value.frameRate) && value.frameRate > 0))
    && (value.allowedFrames === undefined || (Number.isInteger(value.allowedFrames) && value.allowedFrames >= 0))
    && isNonEmptyString(value.reason);
}

export function validateWorkerResult(value: unknown, taskPackage: WorkerTaskPackage): WorkerResult {
  if (!isRecord(value)) throw new Error("Worker 结果必须是对象。");
  if (value.version !== workerResultVersion) throw new Error("Worker 结果版本不受支持。");
  if (!isNonEmptyString(value.taskId) || !isWorkerResultStatus(value.status) || !Array.isArray(value.artifacts) || !isRecord(value.validation) || !Array.isArray(value.blockers) || !isRecord(value.retry) || !isNonEmptyString(value.nextStep)) {
    throw new Error("Worker 结果缺少必填字段。");
  }
  if (typeof value.validation.passed !== "boolean" || !Array.isArray(value.validation.checks)) throw new Error("Worker 结果缺少验证信息。");
  const actualCostCents = value.actualCostCents;
  if (!isNonNegativeInteger(actualCostCents)) throw new Error("实际成本必须是非负整数。");
  const audioDurationSeconds = value.audioDurationSeconds;
  if (audioDurationSeconds !== undefined && !isPositiveFiniteNumber(audioDurationSeconds)) throw new Error("音频实际时长必须是正数。");
  const preflight = value.preflight === undefined ? undefined : parseWorkerPreflight(value.preflight);
  const mediaSource = value.mediaSource === undefined ? undefined : parseMediaSource(value.mediaSource);
  const acousticAlignment = value.acousticAlignment === undefined ? undefined : value.acousticAlignment;
  if (acousticAlignment !== undefined && !isValidAcousticAlignmentResult(acousticAlignment)) throw new Error("声学对齐结果格式无效。");
  const visualAssetRequests = value.visualAssetRequests === undefined ? undefined : parseVisualAssetRequests(value.visualAssetRequests, taskPackage.assets.inputs);
  if (taskPackage.provider === "freesound" && value.status === "completed" && mediaSource === undefined) throw new Error("Freesound 任务必须返回媒体来源记录。");
  if (taskPackage.provider !== "freesound" && mediaSource !== undefined) throw new Error("非 Freesound 任务不能返回媒体来源记录。");
  if ((taskPackage.capability === "narration_generation" || taskPackage.capability === "embedded_audio_extraction" || taskPackage.capability === "soundtrack_generation") && value.status === "completed" && audioDurationSeconds === undefined) throw new Error("已完成音频任务必须返回实际时长。");
  if (taskPackage.capability === "acoustic_alignment" && value.status === "completed" && acousticAlignment === undefined) throw new Error("声学对齐任务必须返回对齐结果或明确的失败状态。");
  if (taskPackage.capability !== "narration_generation" && taskPackage.capability !== "acoustic_alignment" && acousticAlignment !== undefined) throw new Error("非旁白或字幕对齐任务不能返回声学对齐结果。");
  if (value.taskId !== taskPackage.task.id) throw new Error("Worker 结果不属于当前任务。");
  value.artifacts.forEach(assertArtifactManifest);
  const artifacts = value.artifacts as ArtifactManifest[];
  value.validation.checks.forEach(assertValidationCheck);
  value.blockers.forEach(assertBlocker);
  assertRetry(value.retry);

  const storyboard = taskPackage.capability === "storyboard_planning" && value.status === "completed"
    ? validateStoryboardManifest(value.storyboard, taskPackage.assets.inputs)
    : undefined;
  if (taskPackage.capability === "storyboard_planning" && value.status !== "completed" && value.storyboard !== null) throw new Error("未完成的分镜任务必须返回空分镜内容。");
  if (taskPackage.capability !== "storyboard_planning" && value.storyboard !== undefined) throw new Error("非分镜任务不能返回分镜内容。");
  if (taskPackage.capability !== "visual_planning" && visualAssetRequests !== undefined) throw new Error("非视觉资产准备任务不能返回图片生成需求。");
  if (taskPackage.visualAssetPreparation && value.status === "completed" && visualAssetRequests === undefined) throw new Error("视觉资产准备必须明确返回图片生成需求。" );
  if (value.status === "completed" && (!value.validation.passed || value.artifacts.length === 0 || value.blockers.length > 0)) {
    throw new Error("已完成结果必须包含通过验证的产物，且不能带有 blockers。");
  }
  if (value.status === "completed" && !taskPackage.output.requiredArtifactTypes.every((artifactType) => artifacts.some((artifact) => artifact.artifactType === artifactType))) {
    throw new Error("已完成结果缺少必需产物。");
  }
  if (value.status === "completed" && artifacts.some((artifact) => artifact.artifactType === "static_visual" && artifact.relativePath.toLowerCase().endsWith(".svg"))) {
    throw new Error("静态视觉正式产物不能使用 SVG 占位图。");
  }
  if (value.status === "completed" && artifacts.some((artifact) => artifact.artifactType === "static_visual" && !isPreviewableImagePath(artifact.relativePath))) {
    throw new Error("静态视觉产物必须使用可预览图片路径。");
  }
  if (value.status === "completed" && !artifacts.some((artifact) => artifact.artifactType === taskPackage.output.requiredArtifactTypes[0] && artifact.relativePath === taskPackage.output.relativePath)) {
    throw new Error("已完成结果未使用任务包冻结输出路径。");
  }
  if (value.status === "blocked" && value.blockers.length === 0) throw new Error("blocked 结果必须包含 blockers。");
  if ((value.status === "completed" || value.status === "blocked") && value.retry.shouldRetry) throw new Error("已完成或 blocked 结果不能请求重试。");
  if (value.status === "failed" && value.retry.shouldRetry && taskPackage.budget.attempt + 1 >= taskPackage.budget.maxAttempts) throw new Error("失败任务已达到最大重试次数，不能继续重试。");

  return {
    version: workerResultVersion,
    taskId: value.taskId,
    status: value.status,
    artifacts,
    ...(storyboard ? { storyboard } : {}),
    ...(visualAssetRequests ? { visualAssetRequests } : {}),
    validation: {
      passed: value.validation.passed,
      checks: value.validation.checks as WorkerResult["validation"]["checks"],
    },
    ...(preflight ? { preflight } : {}),
    actualCostCents,
    ...(audioDurationSeconds !== undefined ? { audioDurationSeconds } : {}),
    ...(acousticAlignment ? { acousticAlignment } : {}),
    ...(mediaSource ? { mediaSource: { provider: "freesound", sourceId: mediaSource.sourceId, title: mediaSource.title, creator: mediaSource.creator, license: mediaSource.license, sourceUrl: mediaSource.sourceUrl, previewUrl: mediaSource.previewUrl } } : {}),
    blockers: value.blockers as WorkerResult["blockers"],
    retry: value.retry as WorkerResult["retry"],
    nextStep: value.nextStep,
  };
}

function parseVisualAssetRequests(value: unknown, frozenInputs: ArtifactManifest[]): VisualAssetRequest[] {
  if (!Array.isArray(value)) throw new Error("视觉图片生成需求格式无效。");
  const ids = new Set<string>();
  return value.map((request) => {
    if (!isRecord(request) || !isNonEmptyString(request.id) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.id) || !isNonEmptyString(request.prompt) || request.prompt.length > 4_000 || !Array.isArray(request.inputBasis) || request.inputBasis.length === 0 || ids.has(request.id)) throw new Error("视觉图片生成需求格式无效。");
    ids.add(request.id);
    const inputBasis = request.inputBasis.map((input) => {
      if (!isRecord(input) || !isSafeRelativePath(input.relativePath) || !isSha256(input.sha256) || !frozenInputs.some((artifact) => artifact.relativePath === input.relativePath && artifact.sha256 === input.sha256)) throw new Error("视觉图片生成需求引用了未冻结输入。");
      return { relativePath: input.relativePath, sha256: input.sha256 };
    });
    return { id: request.id, prompt: request.prompt, inputBasis };
  });
}

export function validateStoryboardManifest(value: unknown, frozenInputs: ArtifactManifest[]): StoryboardManifest {
  if (!isRecord(value) || value.version !== "storyboard/v1" || !Array.isArray(value.shots) || value.shots.length === 0) throw new Error("分镜内容格式无效。");
  const shotIds = new Set<string>();
  const shots = value.shots.map((candidate) => {
    if (!isRecord(candidate) || !isNonEmptyString(candidate.id) || !isNonEmptyString(candidate.scriptSegment) || !isNonNegativeNumber(candidate.durationSeconds) || candidate.durationSeconds <= 0 || (candidate.shotType !== "a_roll" && candidate.shotType !== "b_roll") || !isNonEmptyString(candidate.productionMethod) || !Array.isArray(candidate.inputBasis) || candidate.inputBasis.length === 0 || !isNonEmptyString(candidate.targetSpec)) throw new Error("分镜镜头格式无效。");
    if (shotIds.has(candidate.id)) throw new Error("分镜镜头 ID 不能重复。");
    shotIds.add(candidate.id);
    const shotType = candidate.shotType as StoryboardShotManifest["shotType"];
    const inputBasis = candidate.inputBasis.map((input) => {
      if (!isRecord(input) || !isSafeRelativePath(input.relativePath) || !isSha256(input.sha256)) throw new Error("分镜镜头输入依据格式无效。");
      const frozenInput = frozenInputs.find((artifact) => artifact.relativePath === input.relativePath && artifact.sha256 === input.sha256);
      if (!frozenInput) throw new Error("分镜镜头引用了未冻结输入。");
      return { relativePath: input.relativePath, sha256: input.sha256 };
    });
    if (!inputBasis.some((input) => frozenInputs.some((artifact) => artifact.artifactType === "main_script" && artifact.relativePath === input.relativePath && artifact.sha256 === input.sha256))) throw new Error("每个分镜镜头必须引用冻结主脚本。");
    if (!inputBasis.some((input) => frozenInputs.some((artifact) => artifact.artifactType !== "main_script" && artifact.relativePath === input.relativePath && artifact.sha256 === input.sha256))) throw new Error("每个分镜镜头必须引用冻结视觉依据。");
    return {
      id: candidate.id,
      scriptSegment: candidate.scriptSegment,
      durationSeconds: candidate.durationSeconds,
      shotType,
      productionMethod: candidate.productionMethod,
      inputBasis,
      targetSpec: candidate.targetSpec,
    };
  });
  const audioCuesValue = value.audioCues;
  if (audioCuesValue !== undefined && !Array.isArray(audioCuesValue)) throw new Error("分镜声轨声明格式无效。");
  const audioCueIds = new Set<string>();
  const audioCues = (audioCuesValue ?? []).map((candidate) => {
    validateStoryboardAudioCue(candidate);
    if (!isRecord(candidate)) throw new Error("分镜声轨声明格式无效。");
    if (audioCueIds.has(candidate.id)) throw new Error("分镜声轨声明 ID 不能重复。");
    audioCueIds.add(candidate.id);
    return { id: candidate.id, kind: candidate.kind as StoryboardAudioCue["kind"], description: candidate.description, searchQuery: candidate.searchQuery, startSeconds: candidate.startSeconds, durationSeconds: candidate.durationSeconds };
  });
  return { version: "storyboard/v1", shots, audioCues };
}

function validateStoryboardAudioCue(value: unknown): asserts value is StoryboardAudioCue {
  if (!isRecord(value) || !isNonEmptyString(value.id) || (value.kind !== "bgm" && value.kind !== "sfx") || !isNonEmptyString(value.description) || !isNonEmptyString(value.searchQuery) || value.searchQuery.length > 100 || !isNonNegativeNumber(value.startSeconds) || !isPositiveFiniteNumber(value.durationSeconds)) throw new Error("分镜声轨声明格式无效。");
}

function validateReviewRenderStoryboard(value: StoryboardManifest): void {
  if (value.version !== "storyboard/v1" || value.shots.length === 0 || value.shots.some((shot) => !isNonEmptyString(shot.id) || !isNonEmptyString(shot.scriptSegment) || !isPositiveFiniteNumber(shot.durationSeconds))) throw new Error("冻结审核渲染分镜格式无效。 ");
}

function validateConfirmedShotPreparationRender(render: NonNullable<WorkerTaskPackageInput["reviewRender"]>): void {
  if (!render.confirmedShots || render.confirmedShots.length !== render.storyboard.shots.length) throw new Error("逐镜头 Studio 工程缺少完整确认快照。 ");
  const confirmed = new Map(render.confirmedShots.map((shot) => [shot.shotId, shot]));
  if (confirmed.size !== render.confirmedShots.length || render.storyboard.shots.some((shot) => !confirmed.has(shot.id))) throw new Error("逐镜头 Studio 工程的确认版本与分镜不一致。 ");
  if (render.confirmedShots.some((shot) => {
    const usesRawSource = isNonEmptyString(shot.sourceMaterialRevisionId) && validClipSegments(shot.clipSegments);
    const usesPreparedClip = isNonEmptyString(shot.videoArtifactId) && isNonEmptyString(shot.videoTaskId);
    const audioValid = shot.audioMode === "none" || (usesRawSource && shot.audioMode === "source") ? shot.audioTrackId === null : isNonEmptyString(shot.audioTrackId);
    return shot.confirmationStatus !== "confirmed" || !isNonEmptyString(shot.inputFingerprint) || !/^[0-9a-f]{32}$/i.test(shot.inputFingerprint) || (!usesRawSource && !usesPreparedClip) || typeof shot.subtitleText !== "string" || (shot.subtitlesEnabled && !shot.subtitleText.trim()) || (shot.audioMode !== "none" && shot.audioMode !== "source" && shot.audioMode !== "tts") || typeof shot.subtitlesEnabled !== "boolean" || !isValidShotComposition(shot.composition ?? normalizeShotComposition(undefined), Math.max(1, shot.clipSegments?.length ?? 1)) || !isValidShotPreparationContract(shot.preparationContract) || shot.preparationContract.inputFingerprint !== shot.inputFingerprint || !audioValid;
    }) || render.confirmedShots.some((shot) => shot.durationDecision !== undefined && !isShotDurationDecision(shot.durationDecision))) throw new Error("逐镜头 Studio 确认快照格式无效。 ");
  const shotMembers = render.members.filter((member) => member.memberKind === "shot_media");
  if (shotMembers.length !== render.storyboard.shots.length || new Set(shotMembers.map((member) => member.memberKey)).size !== shotMembers.length) throw new Error("逐镜头 Studio 工程缺少唯一镜头媒体成员。 ");
  const narrationMembers = render.members.filter((member) => member.memberKind === "narration");
  if (new Set(narrationMembers.map((member) => member.memberKey)).size !== narrationMembers.length) throw new Error("逐镜头 Studio 工程包含重复音频成员。 ");
  for (const shot of render.storyboard.shots) {
    const snapshot = confirmed.get(shot.id)!;
    const member = shotMembers.find((candidate) => candidate.memberKey === `shot:${shot.id}`);
    const rawSourceMatches = snapshot.sourceMaterialRevisionId !== undefined && member?.sourceMaterialRevisionId === snapshot.sourceMaterialRevisionId && JSON.stringify(member.clipSegments) === JSON.stringify(snapshot.clipSegments);
    const preparedClipMatches = snapshot.videoTaskId !== undefined && member?.taskId === snapshot.videoTaskId && member.artifactId === snapshot.videoArtifactId;
    if (!member || (!rawSourceMatches && !preparedClipMatches) || member.inputFingerprint !== snapshot.inputFingerprint || member.audioMode !== snapshot.audioMode || member.subtitleText !== snapshot.subtitleText || member.subtitlesEnabled !== snapshot.subtitlesEnabled || JSON.stringify(member.composition ?? normalizeShotComposition(undefined)) !== JSON.stringify(snapshot.composition ?? normalizeShotComposition(undefined)) || JSON.stringify(member.preparationContract) !== JSON.stringify(snapshot.preparationContract) || (member.clipSegments && Math.abs(member.durationSeconds - shotCompositionTiming(member.clipSegments, member.composition).playbackDurationSeconds) > 0.001) || (snapshot.durationDecision !== undefined && JSON.stringify(member.durationDecision) !== JSON.stringify(snapshot.durationDecision))) throw new Error("逐镜头 Studio 工程存在未确认或版本不一致的镜头成员。 ");
    const narration = render.members.find((candidate) => candidate.memberKey === `narration:${shot.id}`);
    const embeddedSourceAudio = snapshot.sourceMaterialRevisionId !== undefined && snapshot.audioMode === "source";
    if (snapshot.audioMode === "none" || embeddedSourceAudio ? narration !== undefined || snapshot.audioTrackId !== null : !narration || narration.audioTrackId !== snapshot.audioTrackId || narration.audioMode !== snapshot.audioMode) throw new Error("逐镜头 Studio 工程的音频版本与确认快照不一致。 ");
    if (narration && (!narration.taskId || !narration.audioTrackId)) throw new Error("逐镜头 Studio 工程的音频成员缺少冻结版本。 ");
  }
  if (render.members.some((member) => member.memberKind === "shot_media" && !render.storyboard.shots.some((shot) => member.memberKey === `shot:${shot.id}`)) || render.members.some((member) => member.memberKind === "narration" && !render.storyboard.shots.some((shot) => member.memberKey === `narration:${shot.id}`))) throw new Error("逐镜头 Studio 工程包含未确认镜头成员。 ");
}

function isValidShotPreparationContract(value: unknown): value is ShotPreparationContract {
  if (!isRecord(value) || value.version !== "shot-preparation/v1" || !/^[0-9a-f]{32}$/i.test(String(value.storyboardFingerprint)) || !/^[0-9a-f]{32}$/i.test(String(value.inputFingerprint)) || (value.sourceMaterialRevisionId !== null && !isNonEmptyString(value.sourceMaterialRevisionId)) || !validClipSegments(value.clipSegments) || !isValidShotComposition(value.composition, value.clipSegments.length) || !shotTransitionModes.includes(value.transitionMode as ShotTransitionMode) || (value.audioMode !== "none" && value.audioMode !== "source" && value.audioMode !== "tts") || (value.ttsText !== null && typeof value.ttsText !== "string") || (value.ttsVoice !== null && typeof value.ttsVoice !== "string") || (value.ttsSpeakingRate !== null && !isPositiveFiniteNumber(value.ttsSpeakingRate)) || !isValidShotAudioMix(value.audioMix) || value.audioMix.mainVoice.mode !== value.audioMode || !isValidShotCaptionContract(value.captions)) return false;
  if (value.captions.contentMode === "follow_tts" && (value.audioMode !== "tts" || value.captions.text !== value.ttsText)) return false;
  return true;
}

function validClipSegments(value: unknown): value is Array<{ startSeconds: number; endSeconds: number }> {
  return Array.isArray(value) && value.length > 0 && value.every((segment) => isRecord(segment) && isNonNegativeNumber(segment.startSeconds) && isPositiveFiniteNumber(segment.endSeconds) && segment.endSeconds > segment.startSeconds);
}

function parseMediaSource(value: unknown): NonNullable<WorkerResult["mediaSource"]> {
  if (!isRecord(value) || value.provider !== "freesound" || !isPositiveInteger(value.sourceId) || !isNonEmptyString(value.title) || !isNonEmptyString(value.creator) || !isNonEmptyString(value.license) || !isHttpUrl(value.sourceUrl) || !isHttpUrl(value.previewUrl)) throw new Error("媒体来源记录无效。");
  return { provider: "freesound", sourceId: value.sourceId, title: value.title, creator: value.creator, license: value.license, sourceUrl: value.sourceUrl, previewUrl: value.previewUrl };
}

function assertArtifactManifest(value: unknown): asserts value is ArtifactManifest {
  if (!isRecord(value) || !isNonEmptyString(value.artifactType) || !isSha256(value.sha256) || !isNonNegativeInteger(value.fileSize)) {
    throw new Error("产物清单格式无效。");
  }
  if (!isSafeRelativePath(value.relativePath)) throw new Error("产物必须使用资产根目录下的相对路径。");
}

function assertValidationCheck(value: unknown): void {
  if (!isRecord(value) || !isNonEmptyString(value.name) || typeof value.passed !== "boolean" || !isNonEmptyString(value.detail)) throw new Error("验证检查格式无效。");
}

function assertBlocker(value: unknown): void {
  if (!isRecord(value) || !isNonEmptyString(value.code) || !isNonEmptyString(value.detail)) throw new Error("blockers 格式无效。");
  if (value.capability !== undefined && !isNonEmptyString(value.capability)) throw new Error("blocker capability 格式无效。");
  if (value.check !== undefined && !isNonEmptyString(value.check)) throw new Error("blocker check 格式无效。");
  if (value.phase !== undefined && !isWorkerPreflightPhase(value.phase)) throw new Error("blocker phase 格式无效。");
  if (value.status !== undefined && !isWorkerPreflightStatus(value.status)) throw new Error("blocker status 格式无效。");
  if (value.action !== undefined && !isWorkerPreflightAction(value.action)) throw new Error("blocker action 格式无效。");
  if (value.scope !== undefined && !isWorkerPreflightScope(value.scope)) throw new Error("blocker scope 格式无效。");
}

export function parseWorkerPreflight(value: unknown): WorkerPreflightResult {
  if (!isRecord(value) || (value.version !== "worker-preflight/v1" && value.version !== workerPreflightVersion) || !Array.isArray(value.checks)) throw new Error("Worker preflight 格式无效。");
  return { version: workerPreflightVersion, checks: value.checks.map((check) => {
    if (!isRecord(check) || !isNonEmptyString(check.capability) || !isNonEmptyString(check.check) || !isWorkerPreflightPhase(check.phase) || !isWorkerPreflightStatus(check.status) || !isNonEmptyString(check.reason) || !isWorkerPreflightAction(check.action) || !isWorkerPreflightScope(check.scope)) throw new Error("Worker preflight 检查项格式无效。");
    return { ...(typeof check.adapter === "string" ? { adapter: check.adapter } : {}), capability: check.capability, check: check.check, phase: check.phase, status: check.status, reason: check.reason, action: check.action, scope: check.scope };
  }) };
}

function isWorkerPreflightPhase(value: unknown): value is WorkerPreflightPhase {
  return value === "preflight" || value === "execution";
}

function isWorkerPreflightStatus(value: unknown): value is WorkerPreflightStatus {
  return value === "passed" || value === "blocked" || value === "retryable" || value === "unavailable";
}

function isWorkerPreflightAction(value: unknown): value is WorkerPreflightAction {
  return value === "none" || value === "edit_blueprint" || value === "manage_connection" || value === "retry" || value === "contact_environment_admin";
}

function isWorkerPreflightScope(value: unknown): value is WorkerPreflightScope {
  return value === "blueprint" || value === "connection" || value === "episode" || value === "worker";
}

function assertRetry(value: Record<string, unknown>): asserts value is WorkerResult["retry"] {
  if (typeof value.shouldRetry !== "boolean" || !isNonEmptyString(value.reason)) throw new Error("重试信息格式无效。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isConnectionId(value: string | undefined): boolean {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isWorkerResultStatus(value: unknown): value is WorkerResultStatus {
  return value === "completed" || value === "blocked" || value === "failed";
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !/^[a-zA-Z]:[\\/]/.test(value)
    && !value.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..");
}

function isPreviewableImagePath(value: string): boolean {
  return /\.(avif|gif|jpe?g|png|webp)$/i.test(value);
}
