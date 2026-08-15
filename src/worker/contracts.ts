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
}

export interface WorkerTaskPackageInput {
  task: {
    id: string;
    type: string;
    attempt: number;
    budgetLimitCents: number;
    maxAttempts: number;
    provider: "codex";
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
  provider: "codex";
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
  return { version: "storyboard/v1", shots };
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

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
