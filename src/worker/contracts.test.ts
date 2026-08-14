import { describe, expect, it } from "vitest";
import { createWorkerTaskPackage, validateWorkerResult } from "./contracts";
import type { WorkerTaskPackageInput } from "./contracts";

const packageInput: WorkerTaskPackageInput = {
  task: {
    id: "task-1",
    type: "draft_brief",
    attempt: 0,
    budgetLimitCents: 0,
    maxAttempts: 2,
    provider: "codex",
    model: "gpt-5.6-codex",
    promptVersion: "brief-v1",
  },
  episode: {
    id: "episode-1",
    accountId: "account-1",
    blueprintVersionId: "blueprint-3",
    title: "一个可验证的选题",
  },
  capability: "visual_planning",
  allowedTools: ["read", "write"],
  allowedAssetRoot: "/Volumes/Media/tk-workflow/account-1",
  output: { requiredArtifactTypes: ["brief"], contentType: "text/markdown", relativePath: "episodes/episode-1/brief.md", reviewStage: "visual_review" },
  inputArtifacts: [
    {
      artifactType: "research_notes",
      relativePath: "episodes/episode-1/research.md",
      sha256: "a".repeat(64),
      fileSize: 128,
    },
  ],
};

describe("Worker 契约", () => {
  it("构建包含固定账号、蓝图、预算和禁止事项的任务包", () => {
    expect(createWorkerTaskPackage(packageInput)).toMatchObject({
      version: "worker-task/v1",
      provider: "codex",
      capability: "visual_planning",
      allowedTools: ["read", "write"],
      accountId: "account-1",
      episode: { id: "episode-1", blueprintVersionId: "blueprint-3" },
      budget: { limitCents: 0, maxAttempts: 2, attempt: 0 },
      assets: { allowedRoot: "/Volumes/Media/tk-workflow/account-1" },
      output: { requiredArtifactTypes: ["brief"], contentType: "text/markdown", relativePath: "episodes/episode-1/brief.md", reviewStage: "visual_review" },
      forbiddenActions: ["approve", "publish", "change_blueprint", "change_episode_stage"],
    });
  });

  it("拒绝缺少资产根目录或预算已耗尽的任务包", () => {
    expect(() => createWorkerTaskPackage({ ...packageInput, allowedAssetRoot: "" })).toThrow("allowedAssetRoot");
    expect(() => createWorkerTaskPackage({ ...packageInput, task: { ...packageInput.task, attempt: 2 } })).toThrow("maxAttempts");
    expect(() => createWorkerTaskPackage({ ...packageInput, inputArtifacts: [{ ...packageInput.inputArtifacts[0], relativePath: "../outside.md" }] })).toThrow("相对路径");
  });

  it("只接受在预算内、带验证结果的完整 Worker 结果", () => {
    const taskPackage = createWorkerTaskPackage(packageInput);
    expect(validateWorkerResult({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "completed",
      artifacts: [{ artifactType: "brief", relativePath: "episodes/episode-1/brief.md", sha256: "b".repeat(64), fileSize: 256 }],
      validation: { passed: true, checks: [{ name: "schema", passed: true, detail: "brief fields are present" }] },
      actualCostCents: 0,
      blockers: [],
      retry: { shouldRetry: false, reason: "Completed successfully." },
      nextStep: "Create the script draft task.",
    }, taskPackage)).toMatchObject({ status: "completed", actualCostCents: 0 });

    expect(() => validateWorkerResult({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "completed",
      artifacts: [],
      validation: { passed: true, checks: [] },
      actualCostCents: 1,
      blockers: [],
      retry: { shouldRetry: false, reason: "Budget exceeded." },
      nextStep: "Continue.",
    }, taskPackage)).toThrow("预算");
  });

  it("要求 blocked 结果明确说明阻塞原因", () => {
    expect(() => validateWorkerResult({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "blocked",
      artifacts: [],
      validation: { passed: false, checks: [] },
      actualCostCents: 0,
      blockers: [],
      retry: { shouldRetry: false, reason: "Missing inputs need owner action." },
      nextStep: "Wait.",
    }, createWorkerTaskPackage(packageInput))).toThrow("blockers");
  });

  it("只允许未达最大尝试次数的失败任务重试", () => {
    expect(validateWorkerResult({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "failed",
      artifacts: [],
      validation: { passed: false, checks: [{ name: "provider", passed: false, detail: "temporary service failure" }] },
      actualCostCents: 0,
      blockers: [],
      retry: { shouldRetry: true, reason: "Retry after the provider recovers." },
      nextStep: "Retry the same task.",
    }, createWorkerTaskPackage(packageInput))).toMatchObject({ status: "failed", retry: { shouldRetry: true } });

    expect(() => validateWorkerResult({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "failed",
      artifacts: [],
      validation: { passed: false, checks: [] },
      actualCostCents: 0,
      blockers: [],
      retry: { shouldRetry: true, reason: "Keep retrying." },
      nextStep: "Retry.",
    }, createWorkerTaskPackage({ ...packageInput, task: { ...packageInput.task, attempt: 1 } }))).toThrow("重试");
  });

  it("要求结果匹配任务输出类型，并使用资产根目录下的相对路径", () => {
    const taskPackage = createWorkerTaskPackage(packageInput);

    expect(() => validateWorkerResult({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "completed",
      artifacts: [{ artifactType: "script", relativePath: "episodes/episode-1/script.md", sha256: "c".repeat(64), fileSize: 256 }],
      validation: { passed: true, checks: [{ name: "schema", passed: true, detail: "valid" }] },
      actualCostCents: 0,
      blockers: [],
      retry: { shouldRetry: false, reason: "Completed successfully." },
      nextStep: "Continue.",
    }, taskPackage)).toThrow("必需产物");

    expect(() => validateWorkerResult({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "completed",
      artifacts: [{ artifactType: "brief", relativePath: "../outside.md", sha256: "c".repeat(64), fileSize: 256 }],
      validation: { passed: true, checks: [{ name: "schema", passed: true, detail: "valid" }] },
      actualCostCents: 0,
      blockers: [],
      retry: { shouldRetry: false, reason: "Completed successfully." },
      nextStep: "Continue.",
    }, taskPackage)).toThrow("相对路径");

    expect(() => validateWorkerResult({
      version: "worker-result/v1",
      taskId: "another-task",
      status: "completed",
      artifacts: [{ artifactType: "brief", relativePath: "episodes/episode-1/brief.md", sha256: "c".repeat(64), fileSize: 256 }],
      validation: { passed: true, checks: [{ name: "schema", passed: true, detail: "valid" }] },
      actualCostCents: 0,
      blockers: [],
      retry: { shouldRetry: false, reason: "Completed successfully." },
      nextStep: "Continue.",
    }, taskPackage)).toThrow("当前任务");

    expect(() => validateWorkerResult({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "completed",
      artifacts: [{ artifactType: "brief", relativePath: "episodes/episode-1/brief-v2.md", sha256: "c".repeat(64), fileSize: 256 }],
      validation: { passed: true, checks: [{ name: "schema", passed: true, detail: "valid" }] },
      actualCostCents: 0,
      blockers: [],
      retry: { shouldRetry: false, reason: "Completed successfully." },
      nextStep: "Continue.",
    }, taskPackage)).toThrow("冻结输出路径");
  });
});
