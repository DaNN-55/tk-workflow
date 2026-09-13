import { describe, expect, it } from "vitest";
import {
  blueprintFormToPolicy,
  blueprintPolicyToForm,
  mediaAdapterConfiguration,
  seriesFormToRules,
  seriesRulesToForm,
  validateMediaAdapter,
  validateMediaAdapters,
  validateSeriesRules,
} from "./configurationFormValues";

describe("账号蓝图表单转换", () => {
  it("保留明确关闭的全部人工审批关卡", () => {
    const form = blueprintPolicyToForm({ approval_gates: [] });

    expect(form.approvalGates).toEqual([]);
    expect(blueprintFormToPolicy(form)).toMatchObject({ approval_gates: [] });
  });

  it("由平台能力配置统一决定账号可选字段和保存规则", () => {
    expect(mediaAdapterConfiguration("b_roll")).toMatchObject({ configurationFields: ["max_attempts"] });
    expect(mediaAdapterConfiguration("narration")).toMatchObject({ configurationFields: ["max_attempts"] });
    expect(mediaAdapterConfiguration("soundtrack")).toMatchObject({ configurationFields: ["max_attempts"] });
  });

  it("不替旧 Pexels 配置猜测执行路径或连接", () => {
    const form = blueprintPolicyToForm({
      b_roll: {
        executor: { provider: "pexels", adapter: "pexels_video", model: "pexels-video-v1", prompt_version: "b-roll-v1" },
        allowed_tools: ["read", "write"],
        per_shot_budget_cents: 10,
        total_budget_cents: 100,
        max_attempts: 1,
        max_concurrency: 1,
        provider_max_concurrency: 1,
      },
    });

    expect(form.mediaAdapters.b_roll).toMatchObject({ adapter: "pexels_video", credentialRef: "" });
    expect(() => validateMediaAdapter("b_roll", form.mediaAdapters.b_roll)).toThrow("执行路径");
    expect(() => validateMediaAdapter("b_roll", { ...form.mediaAdapters.b_roll, executionPath: "external" })).toThrow("外部连接");
  });

  it("默认关闭五项生产能力，并保存启用但未完成的草稿", () => {
    const form = blueprintPolicyToForm({});

    expect(form.enabledMediaAdapters).toEqual([]);

    const result = blueprintFormToPolicy({
      ...form,
      enabledMediaAdapters: ["static_visual", "a_roll", "b_roll", "narration", "soundtrack"],
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ static_visual: {}, a_roll: {}, b_roll: {}, narration: {}, soundtrack: {} });
  });

  it("人工素材路径只冻结路径并清除执行器与连接", () => {
    const form = blueprintPolicyToForm({ a_roll: { execution_path: "manual", executor: { provider: "codex", adapter: "codex" }, credential_ref: "11111111-1111-4111-8111-111111111111" } });
    const result = blueprintFormToPolicy(form) as Record<string, unknown>;

    expect(form.mediaAdapters.a_roll.executionPath).toBe("manual");
    expect(result.a_roll).toEqual({ execution_path: "manual" });
  });

  it("保留已有媒体规则，并在保存时去除用户预算", () => {
    const form = blueprintPolicyToForm({ a_roll: { executor: { provider: "codex", adapter: "codex" } }, soundtrack: { budget_cents: 99 } });

    expect(form.enabledMediaAdapters).toEqual(["a_roll", "soundtrack"]);
    const result = blueprintFormToPolicy(form) as Record<string, unknown>;

    expect(result.a_roll).toEqual(expect.objectContaining({ executor: { provider: "codex", adapter: "codex" } }));
    expect(result.soundtrack).not.toHaveProperty("budget_cents");
  });

  it("保留只含未表单化字段的媒体旧规则", () => {
    const form = blueprintPolicyToForm({ a_roll: { legacy_mode: "keep" }, soundtrack: { cue_source: "legacy" } });
    const result = blueprintFormToPolicy(form) as Record<string, unknown>;

    expect(result.a_roll).toEqual({ legacy_mode: "keep" });
    expect(result.soundtrack).toEqual({ cue_source: "legacy" });
  });

  it("不再从媒体配置保存工具权限字段", () => {
    const form = blueprintPolicyToForm({ a_roll: { allowed_tools: ["network"] }, soundtrack: { allowed_tools: ["network"] } });

    const result = blueprintFormToPolicy(form) as Record<string, unknown>;
    expect(result.a_roll).not.toHaveProperty("allowed_tools");
    expect(result.soundtrack).not.toHaveProperty("allowed_tools");
  });

  it("历史媒体工具字段可读但不会重新写入蓝图", () => {
    const form = blueprintPolicyToForm({ allowed_tools: ["read"], b_roll: { allowed_tools: ["read", "write"] } });
    const result = blueprintFormToPolicy(form) as Record<string, unknown>;

    expect(result.b_roll).not.toHaveProperty("allowed_tools");
  });

  it("配乐历史工具字段不影响保存", () => {
    const form = blueprintPolicyToForm({
      allowed_tools: ["read"],
      soundtrack: { credential_ref: "freesound-default", executor: { provider: "freesound", adapter: "freesound_preview", model: "freesound-preview-v1", prompt_version: "soundtrack-v1" }, allowed_tools: ["network", "write"], budget_cents: 10, max_attempts: 1 },
    });
    const result = blueprintFormToPolicy(form) as Record<string, unknown>;

    expect(form.mediaAdapters.soundtrack.allowedTools).toBe("read");
    expect(result.soundtrack).not.toHaveProperty("allowed_tools");
  });

  it("旧媒体工具不会被归一化成新的账号级规则", () => {
    const form = blueprintPolicyToForm({
      allowed_tools: ["read"],
      b_roll: { allowed_tools: ["network"], executor: { provider: "pexels", adapter: "pexels_video", model: "pexels-video-v1", prompt_version: "b-roll-v1" }, per_shot_budget_cents: 10, total_budget_cents: 100, max_attempts: 1, max_concurrency: 1, provider_max_concurrency: 1 },
    });
    const result = blueprintFormToPolicy(form) as Record<string, unknown>;

    expect(form.mediaAdapters.b_roll.allowedTools).toBe("read");
    expect(result.b_roll).not.toHaveProperty("allowed_tools");
  });

  it("媒体工具字段不再参与直接提交校验", () => {
    const form = blueprintPolicyToForm({});
    expect(() => blueprintFormToPolicy({
      ...form,
      allowedTools: ["read"],
      enabledMediaAdapters: ["b_roll"],
      mediaAdapters: {
        ...form.mediaAdapters,
        b_roll: { ...form.mediaAdapters.b_roll, provider: "pexels", adapter: "pexels_video", model: "pexels-video-v1", promptVersion: "b-roll-v1", allowedTools: "network", perShotBudgetCents: "10", totalBudgetCents: "100", maxAttempts: "1", maxConcurrency: "1", providerMaxConcurrency: "1" },
      },
    })).not.toThrow();
  });

  it("轮换后拒绝仍冻结的旧外部连接版本", () => {
    const form = blueprintPolicyToForm({
      b_roll: { execution_path: "external", credential_ref: "11111111-1111-4111-8111-111111111111", executor: { provider: "pexels", adapter: "pexels_video", model: "pexels-video-v1", prompt_version: "b-roll-v1" }, allowed_tools: ["read", "write"], max_attempts: 1, max_concurrency: 1, provider_max_concurrency: 1 },
    });

    expect(() => validateMediaAdapter("b_roll", form.mediaAdapters.b_roll, { availableExternalConnectionVersionIds: ["22222222-2222-4222-8222-222222222222"] })).toThrow("当前且已验证");
  });

  it("读取常用字段并保留高级规则", () => {
    const form = blueprintPolicyToForm({
      positioning: "越南民俗短视频",
      asset_root: "/Volumes/Media/dao",
      approval_gates: ["script", "qc"],
      allowed_tools: ["read", "write"],
      budgets: { script_writing_cents: 12, visual_planning_cents: 34, storyboard_planning_cents: 56, global_cap_cents: 99 },
      executors: { script_writing: { provider: "codex", model: "gpt-5.6", prompt_version: "script-v2", adapter: "codex", harness_id: "harness-2", temperature: 0.2 } },
      soundtrack: { executor: { provider: "freesound" } },
    });

    expect(form.positioning).toBe("越南民俗短视频");
    expect(form.assetRoot).toBe("/Volumes/Media/dao");
    expect(form.budgets.scriptWritingCents).toBe("0");
    expect(form.mediaAdapters.soundtrack.provider).toBe("freesound");
    expect(form.executors.script_writing).toMatchObject({ adapter: "codex", harnessId: "harness-2" });
    expect(form.advancedJson).not.toContain("soundtrack");
    expect(form.advancedJson).not.toContain("global_cap_cents");
    expect(form.advancedJson).toContain("temperature");
  });

  it("把媒体适配器从高级 JSON 提升为独立配置字段", () => {
    const form = blueprintPolicyToForm({
      a_roll: { executor: { provider: "codex", adapter: "codex", model: "video-model", prompt_version: "a-roll-v1" }, allowed_tools: ["read", "write"], budget_cents: 20, max_attempts: 2 },
      narration: { credential_ref: "google-tts-default", executor: { provider: "google_tts", adapter: "google_tts", model: "tts-model", prompt_version: "narration-v1" }, allowed_tools: ["network", "write"], budget_cents: 12, max_attempts: 1, voice: { language_code: "zh-CN", name: "voice-a", speaking_rate: 1 } },
    });

    expect(form.mediaAdapters.a_roll.adapter).toBe("codex");
    expect(form.mediaAdapters.a_roll.allowedTools).toBe("read, write");
    expect(form.mediaAdapters.narration.voiceName).toBe("");
    expect(form.advancedJson).not.toContain("a_roll");
    expect(form.advancedJson).not.toContain("narration");
  });

  it("用表单字段覆盖已知配置，但不丢失高级字段", () => {
    const result = blueprintFormToPolicy({
      positioning: "新的账号定位",
      assetRoot: "/Volumes/Media/new",
      approvalGates: ["script", "publish"],
      allowedTools: ["read", "write", "network"],
      budgets: { scriptWritingCents: "10", visualPlanningCents: "20", storyboardPlanningCents: "30" },
      executors: {
        script_writing: { provider: "codex", adapter: "codex", harnessId: "harness-a", model: "model-a", promptVersion: "prompt-a" },
        visual_planning: { provider: "codex", model: "model-b", promptVersion: "prompt-b" },
        storyboard_planning: { provider: "codex", adapter: "codex", harnessId: "harness-storyboard", model: "model-c", promptVersion: "prompt-c" },
      },
      mediaAdapters: {
        static_visual: { provider: "", adapter: "", credentialRef: "", model: "", promptVersion: "", allowedTools: "", budgetCents: "", perShotBudgetCents: "", totalBudgetCents: "", maxAttempts: "", maxConcurrency: "", providerMaxConcurrency: "", voiceLanguageCode: "", voiceName: "", voiceSpeakingRate: "" },
        a_roll: { provider: "codex", adapter: "codex", credentialRef: "", model: "video-model", promptVersion: "a-roll-v1", allowedTools: "read, write", budgetCents: "20", perShotBudgetCents: "", totalBudgetCents: "", maxAttempts: "2", maxConcurrency: "", providerMaxConcurrency: "", voiceLanguageCode: "", voiceName: "", voiceSpeakingRate: "" },
        b_roll: { provider: "pexels", adapter: "pexels_video", credentialRef: "11111111-1111-4111-8111-111111111111", model: "pexels-video-v1", promptVersion: "b-roll-v1", allowedTools: "network, write", budgetCents: "", perShotBudgetCents: "10", totalBudgetCents: "100", maxAttempts: "2", maxConcurrency: "3", providerMaxConcurrency: "2", voiceLanguageCode: "", voiceName: "", voiceSpeakingRate: "" },
        narration: { provider: "google_tts", adapter: "google_tts", credentialRef: "22222222-2222-4222-8222-222222222222", model: "tts-model", promptVersion: "narration-v1", allowedTools: "network, write", budgetCents: "12", perShotBudgetCents: "", totalBudgetCents: "", maxAttempts: "1", maxConcurrency: "", providerMaxConcurrency: "", voiceLanguageCode: "zh-CN", voiceName: "voice-a", voiceSpeakingRate: "0.8" },
        soundtrack: { provider: "freesound", adapter: "freesound_preview", credentialRef: "33333333-3333-4333-8333-333333333333", model: "sound-model", promptVersion: "soundtrack-v1", allowedTools: "network, write", budgetCents: "", perShotBudgetCents: "", totalBudgetCents: "", maxAttempts: "", maxConcurrency: "", providerMaxConcurrency: "", voiceLanguageCode: "", voiceName: "", voiceSpeakingRate: "" },
      },
      advancedJson: '{"soundtrack":{"budget_cents":99}}',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ positioning: "新的账号定位", asset_root: "/Volumes/Media/new", approval_gates: ["script", "publish"] });
    expect(result).not.toHaveProperty("allowed_tools");
    expect(result).toMatchObject({ budgets: { script_writing_cents: 0, storyboard_planning_cents: 0 } });
    expect(result).not.toHaveProperty("budgets.visual_planning_cents");
    expect(result).toMatchObject({ executors: { script_writing: { adapter: "codex", harness_id: "harness-a", model: "model-a" }, storyboard_planning: { adapter: "codex", harness_id: "harness-storyboard", model: "model-c", prompt_version: "prompt-c" } } });
    expect(result).not.toHaveProperty("executors.visual_planning");
    expect(result).toMatchObject({ a_roll: { executor: { adapter: "codex" }, max_attempts: 2 }, b_roll: { executor: { adapter: "pexels_video" } }, narration: { executor: { adapter: "google_tts" }, max_attempts: 1 }, soundtrack: { executor: { adapter: "freesound_preview" } } });
    expect(result.narration).not.toHaveProperty("voice");
    expect(result.a_roll).not.toHaveProperty("budget_cents");
    expect(result.b_roll).not.toHaveProperty("per_shot_budget_cents");
    expect(result.b_roll).not.toHaveProperty("max_concurrency");
    expect(result.narration).not.toHaveProperty("budget_cents");
    expect(result.soundtrack).not.toHaveProperty("budget_cents");
  });

  it("拒绝未完成的媒体适配器配置", () => {
    const form = blueprintPolicyToForm({ a_roll: { executor: { provider: "codex" } } });
    expect(() => validateMediaAdapters(form.mediaAdapters)).toThrow("A-roll适配器");
  });

  it("保存时只校验本轮已开启的媒体能力", () => {
    const form = blueprintPolicyToForm({ a_roll: { executor: { provider: "codex" } }, b_roll: { execution_path: "manual" } });

    expect(() => validateMediaAdapters(form.mediaAdapters, { enabledKeys: ["b_roll"] })).not.toThrow();
    expect(() => validateMediaAdapters(form.mediaAdapters, { enabledKeys: ["a_roll"] })).toThrow("A-roll适配器");
  });

  it("校验旁白和配乐必须选择已登记的外部连接", () => {
    const narration = blueprintPolicyToForm({ narration: { execution_path: "external", credential_ref: "google-tts-default", executor: { provider: "google_tts", adapter: "google_tts", model: "standard", prompt_version: "narration-v1" }, allowed_tools: ["read", "write"], budget_cents: 10, max_attempts: 1, voice: { language_code: "zh-CN", name: "voice-a", speaking_rate: 1 } } }).mediaAdapters.narration;
    const form = blueprintPolicyToForm({ soundtrack: { execution_path: "external", credential_ref: "freesound-default", executor: { provider: "freesound", adapter: "freesound_preview", model: "freesound-preview-v1", prompt_version: "soundtrack-v1" }, allowed_tools: ["read", "write"], budget_cents: 10, max_attempts: 1 } }).mediaAdapters.soundtrack;

    expect(() => validateMediaAdapter("narration", narration)).toThrow("外部连接");
    expect(() => validateMediaAdapter("narration", { ...narration, credentialRef: "" })).toThrow("外部连接");
    expect(() => validateMediaAdapter("soundtrack", { ...form, credentialRef: "11111111-1111-4111-8111-111111111111" })).not.toThrow();
    expect(() => validateMediaAdapter("soundtrack", form)).toThrow("外部连接");
    expect(() => validateMediaAdapter("soundtrack", { ...form, adapter: "other" })).toThrow("未注册 Adapter");
    expect(() => validateMediaAdapter("soundtrack", { ...form, credentialRef: "" })).toThrow("外部连接");
  });

  it("校验静态视觉必须使用 OpenAI 已验证连接版本引用", () => {
    const form = blueprintPolicyToForm({ static_visual: { execution_path: "external", credential_ref: "openai-default", executor: { provider: "openai", adapter: "openai_images", model: "gpt-image-1", prompt_version: "static-visual-v1" }, allowed_tools: ["read", "write"], budget_cents: 10, max_attempts: 1 } }).mediaAdapters.static_visual;
    expect(() => validateMediaAdapter("static_visual", form)).toThrow("外部连接");
    expect(() => validateMediaAdapter("static_visual", { ...form, credentialRef: "44444444-4444-4444-8444-444444444444" })).not.toThrow();
  });
});

describe("系列规则表单转换", () => {
  it("只读取表单支持的创作基线字段", () => {
    const form = seriesRulesToForm({ positioning: "雨夜志怪", format: "短视频", visual_style: "写实", characters: [{ name: "林砚" }], b_roll: { executor: { provider: "pexels" } } });

    expect(form.positioning).toBe("雨夜志怪");
    expect(form.format).toBe("短视频");
    expect(form.characters).toContain("林砚");
    expect(form).not.toHaveProperty("advancedJson");
  });

  it("拒绝系列携带未被表单支持的配置", () => {
    expect(() => validateSeriesRules({ b_roll: { executor: { provider: "pexels" } } })).toThrow("系列规则仅支持表单字段");
  });

  it("往返保存 JSON 数组形式的角色设定", () => {
    const result = seriesFormToRules({ positioning: "", format: "", characters: '[{"name":"林砚"}]', locations: "", visualStyle: "", narrativeStructure: "", restrictions: "" });
    expect(result).toMatchObject({ characters: [{ name: "林砚" }] });
  });
});
