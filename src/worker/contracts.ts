export const workerTaskPackageVersion = "worker-task/v1" as const;
export const workerResultVersion = "worker-result/v1" as const;

export type WorkerResultStatus = "completed" | "blocked" | "failed";

export interface ArtifactManifest {
  artifactType: string;
  relativePath: string;
  sha256: string;
  fileSize: number;
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

export interface WorkerTaskPackageInput {
  task: {
    id: string;
    type: string;
    attempt: number;
    budgetLimitCents: number;
    maxAttempts: number;
    provider: "codex" | "google_tts" | "pexels" | "ffmpeg" | "freesound";
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
  commission?: {
    creativeDirection: string;
    coreContent: string;
  };
  seriesBaseline?: {
    versionId: string;
    version: number;
    rules: unknown;
  };
  reviewFeedback?: {
    reviewPackageId: string;
    reason: string;
  };
  reviewAnnotations?: Array<{
    shotId: string;
    reason: string;
  }>;
  aRoll?: {
    adapter: string;
    shot: StoryboardShotManifest;
  };
  media?:
    | {
      adapter: "google_tts";
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
      adapter: "ffmpeg_extract_audio";
      embeddedAudio: {
        sourceRelativePath: string;
        durationSeconds: number;
      };
    }
    | {
      adapter: "freesound_preview";
      soundtrack: {
        query: string;
        targetDurationSeconds: number;
        cue: StoryboardAudioCue;
      };
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
  commission?: {
    creativeDirection: string;
    coreContent: string;
  };
  seriesBaseline?: {
    versionId: string;
    version: number;
    rules: unknown;
  };
  reviewFeedback?: {
    reviewPackageId: string;
    reason: string;
  };
  reviewAnnotations?: ReadonlyArray<{
    shotId: string;
    reason: string;
  }>;
  aRoll?: {
    adapter: string;
    shot: StoryboardShotManifest;
  };
  media?: WorkerTaskPackageInput["media"];
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
  validation: {
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
  };
  actualCostCents: number;
  audioDurationSeconds?: number;
  mediaSource?: {
    provider: "freesound";
    sourceId: number;
    title: string;
    creator: string;
    license: string;
    sourceUrl: string;
    previewUrl: string;
  };
  blockers: Array<{ code: string; detail: string }>;
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
  if (input.commission && (!isNonEmptyString(input.commission.creativeDirection) || !isNonEmptyString(input.commission.coreContent))) throw new Error("commission must contain creative direction and core content.");
  if (input.seriesBaseline && (!isNonEmptyString(input.seriesBaseline.versionId) || !Number.isInteger(input.seriesBaseline.version) || input.seriesBaseline.version < 1 || !isRecord(input.seriesBaseline.rules))) throw new Error("seriesBaseline must contain a version and rule object.");
  if (input.reviewFeedback && (!isNonEmptyString(input.reviewFeedback.reviewPackageId) || !isNonEmptyString(input.reviewFeedback.reason))) throw new Error("review feedback must contain its package and reason.");
  if (input.reviewAnnotations?.some((annotation) => !isNonEmptyString(annotation.shotId) || !isNonEmptyString(annotation.reason))) throw new Error("review annotations must contain a shot and reason.");
  if (input.capability === "a_roll_generation" && !input.aRoll) throw new Error("a-roll generation requires its frozen adapter and shot.");
  if (input.capability !== "a_roll_generation" && input.aRoll) throw new Error("only a-roll generation may include a frozen shot.");
  if (input.aRoll) {
    if (!isNonEmptyString(input.aRoll.adapter)) throw new Error("a-roll generation requires an adapter.");
    validateStoryboardManifest({ version: "storyboard/v1", shots: [input.aRoll.shot] }, input.inputArtifacts);
  }
  if (input.capability === "narration_generation" && (!input.media || input.media.adapter !== "google_tts")) throw new Error("旁白生成必须包含冻结的 Google TTS 配置。");
  if (input.capability === "b_roll_generation" && (!input.media || input.media.adapter !== "pexels_video")) throw new Error("B-roll 生成必须包含冻结的 Pexels 配置。");
  if (input.capability === "embedded_audio_extraction" && (!input.media || input.media.adapter !== "ffmpeg_extract_audio")) throw new Error("派生音频提取必须包含冻结的视频输入。");
  if (input.capability === "soundtrack_generation" && (!input.media || input.media.adapter !== "freesound_preview")) throw new Error("声轨生成必须包含冻结的 Freesound 配置。");
  if (input.media?.adapter === "google_tts") {
    if (input.task.provider !== "google_tts") throw new Error("旁白任务 Provider 必须与冻结 Google TTS 适配器匹配。");
    const { narration } = input.media;
    if (!isNonEmptyString(narration.text) || !isNonEmptyString(narration.voice.languageCode) || !isNonEmptyString(narration.voice.name) || !isPositiveFiniteNumber(narration.voice.speakingRate)) throw new Error("旁白任务的冻结文本或声音无效。");
  }
  if (input.media?.adapter === "pexels_video") {
    if (input.task.provider !== "pexels") throw new Error("B-roll 任务 Provider 必须与冻结 Pexels 适配器匹配。");
    const { bRoll } = input.media;
    if (!isNonEmptyString(bRoll.query) || !isPositiveFiniteNumber(bRoll.targetDurationSeconds)) throw new Error("B-roll 任务的冻结检索词或时长无效。");
    validateStoryboardManifest({ version: "storyboard/v1", shots: [bRoll.shot] }, input.inputArtifacts);
  }
  if (input.media?.adapter === "ffmpeg_extract_audio") {
    if (input.task.provider !== "ffmpeg") throw new Error("派生音频任务 Provider 必须与冻结 ffmpeg 适配器匹配。");
    const embeddedAudio = input.media.embeddedAudio;
    if (!isSafeRelativePath(embeddedAudio.sourceRelativePath) || !isPositiveFiniteNumber(embeddedAudio.durationSeconds)) throw new Error("派生音频任务的冻结视频输入或时长无效。");
    if (!input.inputArtifacts.some((artifact) => artifact.relativePath === embeddedAudio.sourceRelativePath)) throw new Error("派生音频任务的视频输入未冻结。");
  }
  if (input.media?.adapter === "freesound_preview") {
    if (input.task.provider !== "freesound") throw new Error("声轨任务 Provider 必须与冻结 Freesound 适配器匹配。");
    const soundtrack = input.media.soundtrack;
    if (!isNonEmptyString(soundtrack.query) || soundtrack.query.length > 100 || !isPositiveFiniteNumber(soundtrack.targetDurationSeconds)) throw new Error("声轨任务的冻结检索词或时长无效。");
    validateStoryboardAudioCue(soundtrack.cue);
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
    ...(input.commission ? { commission: { creativeDirection: input.commission.creativeDirection, coreContent: input.commission.coreContent } } : {}),
    ...(input.seriesBaseline ? { seriesBaseline: { versionId: input.seriesBaseline.versionId, version: input.seriesBaseline.version, rules: input.seriesBaseline.rules } } : {}),
    ...(input.reviewFeedback ? { reviewFeedback: { reviewPackageId: input.reviewFeedback.reviewPackageId, reason: input.reviewFeedback.reason } } : {}),
    ...(input.reviewAnnotations?.length ? { reviewAnnotations: input.reviewAnnotations.map((annotation) => ({ shotId: annotation.shotId, reason: annotation.reason })) } : {}),
    ...(input.aRoll ? { aRoll: { adapter: input.aRoll.adapter, shot: input.aRoll.shot } } : {}),
    ...(input.media ? { media: input.media } : {}),
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
  const mediaSource = value.mediaSource === undefined ? undefined : parseMediaSource(value.mediaSource);
  if (taskPackage.provider === "freesound" && value.status === "completed" && mediaSource === undefined) throw new Error("Freesound 任务必须返回媒体来源记录。");
  if (taskPackage.provider !== "freesound" && mediaSource !== undefined) throw new Error("非 Freesound 任务不能返回媒体来源记录。");
  if ((taskPackage.capability === "narration_generation" || taskPackage.capability === "embedded_audio_extraction" || taskPackage.capability === "soundtrack_generation") && value.status === "completed" && audioDurationSeconds === undefined) throw new Error("已完成音频任务必须返回实际时长。");
  if (actualCostCents > taskPackage.budget.limitCents) throw new Error("实际成本超过预算。");

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
  if (value.status === "completed" && (!value.validation.passed || value.artifacts.length === 0 || value.blockers.length > 0)) {
    throw new Error("已完成结果必须包含通过验证的产物，且不能带有 blockers。");
  }
  if (value.status === "completed" && !taskPackage.output.requiredArtifactTypes.every((artifactType) => artifacts.some((artifact) => artifact.artifactType === artifactType))) {
    throw new Error("已完成结果缺少必需产物。");
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
    validation: {
      passed: value.validation.passed,
      checks: value.validation.checks as WorkerResult["validation"]["checks"],
    },
    actualCostCents,
    ...(audioDurationSeconds !== undefined ? { audioDurationSeconds } : {}),
    ...(mediaSource ? { mediaSource: { provider: "freesound", sourceId: mediaSource.sourceId, title: mediaSource.title, creator: mediaSource.creator, license: mediaSource.license, sourceUrl: mediaSource.sourceUrl, previewUrl: mediaSource.previewUrl } } : {}),
    blockers: value.blockers as WorkerResult["blockers"],
    retry: value.retry as WorkerResult["retry"],
    nextStep: value.nextStep,
  };
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
  return /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(value);
}
