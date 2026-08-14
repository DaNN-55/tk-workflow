import { describe, expect, it, vi } from "vitest";
import { dispatchProvidedScriptWork } from "./providedScriptDispatch";

describe("已提供脚本调度", () => {
  it("先冻结待执行任务，再启动 Worker", async () => {
    const events: string[] = [];
    const planTasks = vi.fn(async () => {
      events.push("plan");
      return [{ id: "task-1" }];
    });
    const runWorker = vi.fn(async () => {
      events.push("worker");
      return { status: "completed", taskId: "task-1" };
    });

    await expect(dispatchProvidedScriptWork({ planTasks, runWorker })).resolves.toEqual({
      plannedTasks: 1,
      worker: { status: "completed", taskId: "task-1" },
    });
    expect(events).toEqual(["plan", "worker"]);
  });
});
