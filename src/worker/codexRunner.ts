import {
  createWorkerTaskPackage,
  type ArtifactManifest,
  type WorkerResult,
  type WorkerTaskPackageInput,
  type WorkerTaskPackage,
  validateWorkerResult,
} from "./contracts.js";

export interface ClaimedWorkerTask {
  taskId: string;
  taskType: string;
  attempt: number;
  budgetLimitCents: number;
  maxAttempts: number;
  provider: "codex" | "google_tts" | "pexels" | "ffmpeg";
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
  reportResult(taskId: string, attempt: number, result: WorkerResult): Promise<void>;
  actualCostCents: number;
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
    await dependencies.reportResult(task.taskId, task.attempt, createBlockedResult(task.taskId, dependencies.actualCostCents, error));
    return { status: "blocked", taskId: task.taskId };
  }

  try {
    await dependencies.verifyAssetRoot(taskPackage.assets.allowedRoot);
  } catch (error) {
    await dependencies.reportResult(task.taskId, task.attempt, createBlockedResult(task.taskId, dependencies.actualCostCents, error, "asset_root_unavailable"));
    return { status: "blocked", taskId: task.taskId };
  }

  try {
    await dependencies.verifyArtifacts(taskPackage, taskPackage.assets.inputs);
  } catch (error) {
    await dependencies.reportResult(task.taskId, task.attempt, createBlockedResult(task.taskId, dependencies.actualCostCents, error, "input_artifacts_invalid"));
    return { status: "blocked", taskId: task.taskId };
  }

  try {
    const output = await dependencies.execute(taskPackage);
    const candidate = parseCodexOutput(output, dependencies.actualCostCents);
    const result = validateWorkerResult(candidate, taskPackage);
    await dependencies.verifyArtifacts(taskPackage, result.artifacts, result.storyboard);
    await dependencies.reportResult(task.taskId, task.attempt, result);
    return { status: result.status, taskId: task.taskId };
  } catch (error) {
    await dependencies.reportResult(task.taskId, task.attempt, createFailedResult(taskPackage, dependencies.actualCostCents, error));
    return { status: "failed", taskId: task.taskId };
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
    commission: commission(snapshot),
    seriesBaseline: seriesBaseline(snapshot),
    reviewFeedback: reviewFeedback(snapshot),
    reviewAnnotations: reviewAnnotations(snapshot),
    aRoll: aRoll(snapshot),
    media: media(snapshot),
    allowedTools: stringArray(snapshot.allowed_tools, "任务允许工具清单格式无效。"),
    allowedAssetRoot: task.allowedAssetRoot,
    output,
    inputArtifacts: inputArtifacts(snapshot),
  });
}

function media(snapshot: Record<string, unknown>): WorkerTaskPackageInput["media"] {
  const value = snapshot.media;
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("媒体任务冻结配置格式无效。");
  if (value.adapter === "google_tts") {
    const narration = value.narration;
    if (!isRecord(narration) || !isRecord(narration.voice)) throw new Error("旁白任务冻结配置无效。");
    return {
      adapter: "google_tts",
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
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value.rules) || typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) throw new Error("任务系列基准格式无效。");
  return {
    versionId: requiredString(value.version_id, "任务系列基准缺少版本。"),
    version: value.version,
    rules: value.rules,
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

function parseCodexOutput(output: string, actualCostCents: number): unknown {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown worker error.";
}
