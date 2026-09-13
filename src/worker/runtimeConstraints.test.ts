import { describe, expect, it } from "vitest";
import { workerRequiredTools, workerRuntimeConstraints } from "./runtimeConstraints";

describe("Worker 运行约束", () => {
  it("取可信供应商、Adapter 安全上限和 Worker 容量的最小值", () => {
    expect(workerRuntimeConstraints({ provider: "pexels", adapter: "pexels_video", capability: "b_roll_generation", providerOrConnectionLimit: 3, workerCapacity: 8 })).toMatchObject({ adapterSafetyLimit: 3, effectiveConcurrency: 3 });
    expect(workerRuntimeConstraints({ provider: "pexels", adapter: "pexels_video", capability: "b_roll_generation", providerOrConnectionLimit: 9, workerCapacity: 2 }).effectiveConcurrency).toBe(2);
  });

  it("没有可信供应商上限时使用 Adapter 的保守默认值", () => {
    expect(workerRuntimeConstraints({ adapter: "unknown", workerCapacity: 8 }).effectiveConcurrency).toBe(1);
    expect(workerRequiredTools).toEqual(["read", "write"]);
  });
});
