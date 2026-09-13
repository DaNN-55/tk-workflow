import { describe, expect, it } from "vitest";
import { registeredAdapters } from "./registeredAdapters";

describe("registered adapters", () => {
  it("以稳定身份声明多项能力，而不复制 Adapter", () => {
    const aRoll = registeredAdapters.choicesFor({ capability: "a_roll_generation", executionPath: "local" });
    const bRoll = registeredAdapters.choicesFor({ capability: "b_roll_generation", executionPath: "local" });
    expect(aRoll).toHaveLength(1);
    expect(bRoll).toHaveLength(1);
    expect(aRoll[0].identityKey).toBe("openchatcut:openchatcut_card_video");
    expect(bRoll[0].identityKey).toBe(aRoll[0].identityKey);
  });

  it("Codex 的稳定身份覆盖三项内部生产能力", () => {
    expect(["script_writing", "visual_planning", "storyboard_planning"].map((capability) => registeredAdapters.resolve({ capability, provider: "codex", adapter: "codex" }).kind)).toEqual(["registered", "registered", "registered"]);
  });

  it("返回执行选择所需的连接、目录、执行种类与安全上限", () => {
    const resolution = registeredAdapters.resolve({ capability: "b_roll_generation", executionPath: "external", provider: "pexels", adapter: "pexels_video", model: "pexels-video-v1", preset: "b-roll-v1" });
    expect(resolution).toMatchObject({ kind: "registered", choice: { connection: { kind: "owner_managed", type: "pexels_api" }, execution: { kind: "controlled_media", safetyLimit: 3 } } });
  });

  it("不猜测未注册身份或不匹配的能力", () => {
    expect(registeredAdapters.resolve({ capability: "a_roll_generation", executionPath: "local", provider: "codex", adapter: "codex" })).toMatchObject({ kind: "invalid", code: "capability_unsupported" });
    expect(registeredAdapters.resolve({ capability: "b_roll_generation", executionPath: "external", provider: "hyperframes", adapter: "default" })).toMatchObject({ kind: "invalid", code: "adapter_unregistered" });
  });

  it("只兼容历史渲染任务缺失的明确等价 Adapter", () => {
    expect(registeredAdapters.resolve({ capability: "review_rendering", provider: "openchatcut" })).toMatchObject({ kind: "registered", choice: { adapter: "openchatcut" } });
    expect(registeredAdapters.resolve({ capability: "b_roll_generation", provider: "pexels" })).toMatchObject({ kind: "invalid", code: "adapter_missing" });
  });

  it("把人工路径作为显式结果返回", () => {
    expect(registeredAdapters.resolve({ capability: "a_roll_generation", executionPath: "manual" })).toEqual({ kind: "manual", capability: "a_roll_generation" });
  });
});
