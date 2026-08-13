import { describe, expect, it, vi } from "vitest";
import { runCodexWorker } from "./codexRunner";

const claimedTask = {
  taskId: "task-1",
  taskType: "draft_brief",
  attempt: 0,
  budgetLimitCents: 0,
  maxAttempts: 2,
  provider: "codex" as const,
  model: "gpt-5.6-codex",
  promptVersion: "brief-v1",
  episodeId: "episode-1",
  accountId: "account-1",
  blueprintVersionId: "blueprint-1",
  title: "一个可验证的选题",
  allowedAssetRoot: "/Volumes/Media/tk-workflow/account-1",
  inputSnapshot: { output: { required_artifact_types: ["brief"] }, input_artifacts: [] },
};

describe("本地 Codex Worker runner", () => {
  it("没有 ready 任务时保持空闲，不调用 Codex", async () => {
    const execute = vi.fn();
    const reportResult = vi.fn();

    await expect(runCodexWorker({ claimNextTask: async () => null, reportResult, execute, verifyAssetRoot: async () => undefined, verifyArtifacts: async () => undefined, actualCostCents: 0 })).resolves.toEqual({ status: "idle" });
    expect(execute).not.toHaveBeenCalled();
    expect(reportResult).not.toHaveBeenCalled();
  });

  it("将通过校验的 Codex 结果回写给同一个任务", async () => {
    const reportResult = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "completed",
      artifacts: [{ artifactType: "brief", relativePath: "episodes/episode-1/brief.md", sha256: "a".repeat(64), fileSize: 128 }],
      validation: { passed: true, checks: [{ name: "schema", passed: true, detail: "brief is complete" }] },
      actualCostCents: 999,
      blockers: [],
      retry: { shouldRetry: false, reason: "Completed successfully." },
      nextStep: "Create the script draft task.",
    }));

    await expect(runCodexWorker({ claimNextTask: async () => claimedTask, reportResult, execute, verifyAssetRoot: async () => undefined, verifyArtifacts: async () => undefined, actualCostCents: 0 })).resolves.toEqual({ status: "completed", taskId: "task-1" });
    expect(reportResult).toHaveBeenCalledWith("task-1", 0, expect.objectContaining({ actualCostCents: 0, status: "completed" }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ accountId: "account-1", episode: expect.objectContaining({ blueprintVersionId: "blueprint-1" }) }));
  });

  it("缺少资产根目录时写入 blocked，不调用 Codex", async () => {
    const execute = vi.fn();
    const reportResult = vi.fn().mockResolvedValue(undefined);

    await expect(runCodexWorker({ claimNextTask: async () => ({ ...claimedTask, allowedAssetRoot: "" }), reportResult, execute, verifyAssetRoot: async () => undefined, verifyArtifacts: async () => undefined, actualCostCents: 0 })).resolves.toEqual({ status: "blocked", taskId: "task-1" });
    expect(execute).not.toHaveBeenCalled();
    expect(reportResult).toHaveBeenCalledWith("task-1", 0, expect.objectContaining({ status: "blocked", blockers: expect.any(Array) }));
  });

  it("资产根目录不可访问时写入 blocked，不调用 Codex", async () => {
    const execute = vi.fn();
    const reportResult = vi.fn().mockResolvedValue(undefined);

    await expect(runCodexWorker({
      claimNextTask: async () => claimedTask,
      reportResult,
      execute,
      actualCostCents: 0,
      verifyAssetRoot: async () => { throw new Error("资产根目录未挂载或不可写。"); },
      verifyArtifacts: async () => undefined,
    })).resolves.toEqual({ status: "blocked", taskId: "task-1" });

    expect(execute).not.toHaveBeenCalled();
    expect(reportResult).toHaveBeenCalledWith("task-1", 0, expect.objectContaining({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "asset_root_unavailable" })],
    }));
  });

  it("输入产物校验失败时写入 blocked，不调用 Codex", async () => {
    const execute = vi.fn();
    const reportResult = vi.fn().mockResolvedValue(undefined);

    await expect(runCodexWorker({
      claimNextTask: async () => ({
        ...claimedTask,
        inputSnapshot: {
          ...claimedTask.inputSnapshot,
          input_artifacts: [{ artifactType: "research_notes", relativePath: "episodes/episode-1/research.md", sha256: "a".repeat(64), fileSize: 128 }],
        },
      }),
      reportResult,
      execute,
      actualCostCents: 0,
      verifyAssetRoot: async () => undefined,
      verifyArtifacts: async (_taskPackage, artifacts) => {
        if (artifacts[0]?.artifactType === "research_notes") throw new Error("research.md 的 SHA-256 不匹配。");
      },
    })).resolves.toEqual({ status: "blocked", taskId: "task-1" });

    expect(execute).not.toHaveBeenCalled();
    expect(reportResult).toHaveBeenCalledWith("task-1", 0, expect.objectContaining({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "input_artifacts_invalid" })],
    }));
  });

  it("产物文件无法验证时不回写 completed，而是回写 failed", async () => {
    const reportResult = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      version: "worker-result/v1",
      taskId: "task-1",
      status: "completed",
      artifacts: [{ artifactType: "brief", relativePath: "episodes/episode-1/brief.md", sha256: "a".repeat(64), fileSize: 128 }],
      validation: { passed: true, checks: [{ name: "schema", passed: true, detail: "brief is complete" }] },
      actualCostCents: 0,
      blockers: [],
      retry: { shouldRetry: false, reason: "Completed successfully." },
      nextStep: "Create the script draft task.",
    }));

    await expect(runCodexWorker({
      claimNextTask: async () => claimedTask,
      reportResult,
      execute,
      verifyAssetRoot: async () => undefined,
      verifyArtifacts: async (_taskPackage, artifacts) => {
        if (artifacts.length > 0) throw new Error("brief.md 的 SHA-256 不匹配。");
      },
      actualCostCents: 0,
    })).resolves.toEqual({ status: "failed", taskId: "task-1" });

    expect(reportResult).toHaveBeenCalledWith("task-1", 0, expect.objectContaining({ status: "failed" }));
  });

  it("Codex 执行失败时按任务重试上限回写 failed", async () => {
    const reportResult = vi.fn().mockResolvedValue(undefined);

    await expect(runCodexWorker({ claimNextTask: async () => claimedTask, reportResult, execute: async () => { throw new Error("temporary provider failure"); }, verifyAssetRoot: async () => undefined, verifyArtifacts: async () => undefined, actualCostCents: 0 })).resolves.toEqual({ status: "failed", taskId: "task-1" });
    expect(reportResult).toHaveBeenCalledWith("task-1", 0, expect.objectContaining({ status: "failed", retry: { shouldRetry: true, reason: "temporary provider failure" } }));
  });
});
