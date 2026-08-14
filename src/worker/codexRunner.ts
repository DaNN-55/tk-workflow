import {
  createWorkerTaskPackage,
  type ArtifactManifest,
  type WorkerResult,
  type WorkerTaskPackage,
  validateWorkerResult,
} from "./contracts.js";

export interface ClaimedWorkerTask {
  taskId: string;
  taskType: string;
  attempt: number;
  budgetLimitCents: number;
  maxAttempts: number;
  provider: "codex";
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
  verifyArtifacts(taskPackage: WorkerTaskPackage, artifacts: ArtifactManifest[]): Promise<void>;
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
    await dependencies.verifyArtifacts(taskPackage, result.artifacts);
    await dependencies.reportResult(task.taskId, task.attempt, result);
    return { status: result.status, taskId: task.taskId };
  } catch (error) {
    await dependencies.reportResult(task.taskId, task.attempt, createFailedResult(taskPackage, dependencies.actualCostCents, error));
    return { status: "failed", taskId: task.taskId };
  }
}

function createTaskPackage(task: ClaimedWorkerTask): WorkerTaskPackage {
  const snapshot = isRecord(task.inputSnapshot) ? task.inputSnapshot : {};
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
    allowedAssetRoot: task.allowedAssetRoot,
    output: { requiredArtifactTypes: requiredArtifactTypes(snapshot) },
    inputArtifacts: inputArtifacts(snapshot),
  });
}

function parseCodexOutput(output: string, actualCostCents: number): unknown {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) throw new Error("Codex 必须返回一个 JSON 对象。");
  return { ...parsed, actualCostCents };
}

function requiredArtifactTypes(snapshot: Record<string, unknown>): string[] {
  const output = snapshot.output;
  if (!isRecord(output) || !Array.isArray(output.required_artifact_types)) throw new Error("任务缺少输出产物 Schema。");
  return output.required_artifact_types.filter((artifactType): artifactType is string => typeof artifactType === "string");
}

function inputArtifacts(snapshot: Record<string, unknown>): ArtifactManifest[] {
  const artifacts = snapshot.input_artifacts;
  if (artifacts === undefined) return [];
  if (!Array.isArray(artifacts)) throw new Error("任务输入产物清单格式无效。");
  return artifacts as ArtifactManifest[];
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
