import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../lib/database.types";
import { LearningWorkspace } from "./LearningWorkspace";
import type { SaveBlueprintChangeSuggestionInput, SaveLearningReportInput } from "./LearningWorkspace";

const episode = {
  account_id: "account-1",
  blueprint_version_id: "blueprint-1",
  created_at: "2026-08-13T00:00:00.000Z",
  id: "episode-1",
  stage: "metrics_collecting" as const,
  title: "雨天出门提醒",
  updated_at: "2026-08-13T00:00:00.000Z",
} satisfies Database["public"]["Tables"]["episodes"]["Row"];

const experiment = {
  created_at: "2026-08-13T00:00:00.000Z",
  episode_id: episode.id,
  guardrail_metrics: ["完播率", "互动率"],
  hypothesis: "开头直接给出动作建议会提高播放量。",
  id: "experiment-1",
  primary_metric: "播放量",
  primary_variable: "开头是否直接给出动作建议",
} satisfies Database["public"]["Tables"]["experiments"]["Row"];

const learningReport = {
  created_at: "2026-08-14T00:00:00.000Z",
  created_by: "owner-1",
  episode_id: episode.id,
  id: "report-1",
  recommendation: "change" as const,
  summary: "播放量较基线提升，建议保留开头直接给建议的结构。",
} satisfies Database["public"]["Tables"]["learning_reports"]["Row"];

const blueprintChangeSuggestion = {
  account_id: episode.account_id,
  created_at: "2026-08-14T00:00:00.000Z",
  created_by: "owner-1",
  decision_reason: null,
  id: "suggestion-1",
  learning_report_id: learningReport.id,
  proposed_blueprint_version_id: null,
  proposed_policy: { positioning: "雨天出行建议" },
  rationale: "将有效开头写入账号蓝图。",
  reviewed_at: null,
  reviewed_by: null,
  source_blueprint_version_id: episode.blueprint_version_id,
  status: "pending" as const,
} satisfies Database["public"]["Tables"]["blueprint_change_suggestions"]["Row"];

function workspaceProps(overrides: Partial<Parameters<typeof LearningWorkspace>[0]> = {}) {
  return {
    accountsById: new Map(),
    blueprintVersionsById: new Map([[episode.blueprint_version_id, { account_id: episode.account_id, created_at: "2026-08-13T00:00:00.000Z", id: episode.blueprint_version_id, is_active: true, policy: { positioning: "雨天出行建议" }, version: 1 }]]),
    episodes: [episode],
    experiments: [experiment],
    learningReports: [],
    metricSnapshots: [],
    blueprintChangeSuggestions: [],
    onApproveBlueprintChangeSuggestion: vi.fn().mockResolvedValue(undefined),
    onSaveBlueprintChangeSuggestion: vi.fn().mockResolvedValue(undefined),
    onSaveExperiment: vi.fn().mockResolvedValue(undefined),
    onSaveLearningReport: vi.fn().mockResolvedValue(undefined),
    onSaveMetricSnapshot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("复盘工作台", () => {
  it("为生产单定义一个主指标和最多两个护栏指标", async () => {
    const user = userEvent.setup();
    const onSaveExperiment = vi.fn().mockResolvedValue(undefined);

    render(<LearningWorkspace {...workspaceProps({ experiments: [], onSaveExperiment })} />);

    await user.type(screen.getByLabelText("实验假设"), "开头直接给出动作建议会提高播放量。");
    await user.type(screen.getByLabelText("主要变量"), "开头是否直接给出动作建议");
    await user.type(screen.getByLabelText("主指标"), "播放量");
    await user.type(screen.getByLabelText("护栏指标 1"), "完播率");
    await user.type(screen.getByLabelText("护栏指标 2"), "互动率");
    await user.click(screen.getByRole("button", { name: "保存实验定义" }));

    expect(onSaveExperiment).toHaveBeenCalledWith({
      episodeId: episode.id,
      guardrailMetrics: ["完播率", "互动率"],
      hypothesis: "开头直接给出动作建议会提高播放量。",
      primaryMetric: "播放量",
      primaryVariable: "开头是否直接给出动作建议",
    });
  });

  it("按 ISO 周录入实验的主指标和护栏指标", async () => {
    const user = userEvent.setup();
    const onSaveMetricSnapshot = vi.fn().mockResolvedValue(undefined);

    render(<LearningWorkspace {...workspaceProps({ onSaveMetricSnapshot })} />);

    await user.type(screen.getByLabelText("指标周"), "2026-W33");
    await user.type(screen.getByLabelText("播放量"), "12800");
    await user.type(screen.getByLabelText("完播率"), "42.5");
    await user.type(screen.getByLabelText("互动率"), "6.2");
    await user.click(screen.getByRole("button", { name: "保存本周指标" }));

    expect(onSaveMetricSnapshot).toHaveBeenCalledWith({
      capturedAt: "2026-08-10T00:00:00.000Z",
      episodeId: episode.id,
      metrics: { "播放量": 12800, "完播率": 42.5, "互动率": 6.2 },
    });
  });

  it("不会为已完成复盘的生产单展示周指标提交表单", () => {
    render(<LearningWorkspace {...workspaceProps({ episodes: [{ ...episode, stage: "learning_recorded" }], learningReports: [learningReport] })} />);

    expect(screen.getByText("实验定义")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存本周指标" })).toBeNull();
  });

  it("在已有周指标后记录复盘结论和建议", async () => {
    const user = userEvent.setup();
    const onSaveLearningReport = vi.fn<(input: SaveLearningReportInput) => Promise<void>>().mockResolvedValue(undefined);

    render(<LearningWorkspace {...workspaceProps({ metricSnapshots: [{ captured_at: "2026-08-10T00:00:00.000Z", captured_by: "owner-1", episode_id: episode.id, id: "snapshot-1", metrics: { "播放量": 12800, "完播率": 42.5, "互动率": 6.2 } }], onSaveLearningReport })} />);

    await user.selectOptions(screen.getByLabelText("复盘建议"), "change");
    await user.type(screen.getByLabelText("复盘结论"), "播放量较基线提升，建议保留开头直接给建议的结构。");
    await user.click(screen.getByRole("button", { name: "记录复盘报告" }));

    expect(onSaveLearningReport).toHaveBeenCalledWith({
      episodeId: episode.id,
      recommendation: "change",
      summary: "播放量较基线提升，建议保留开头直接给建议的结构。",
    });
  });

  it("为已记录复盘提交蓝图变更建议，并由 Owner 批准生效", async () => {
    const user = userEvent.setup();
    const onSaveBlueprintChangeSuggestion = vi.fn<(input: SaveBlueprintChangeSuggestionInput) => Promise<void>>().mockResolvedValue(undefined);
    const onApproveBlueprintChangeSuggestion = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(<LearningWorkspace {...workspaceProps({ episodes: [{ ...episode, stage: "learning_recorded" }], learningReports: [learningReport], onSaveBlueprintChangeSuggestion, onApproveBlueprintChangeSuggestion })} />);

    await user.type(screen.getByLabelText("变更理由"), "将有效开头写入账号蓝图。");
    await user.clear(screen.getByLabelText("建议蓝图规则"));
    fireEvent.change(screen.getByLabelText("建议蓝图规则"), { target: { value: '{"positioning":"雨天出行建议（开头直接行动）"}' } });
    await user.click(screen.getByRole("button", { name: "提交蓝图变更建议" }));

    expect(onSaveBlueprintChangeSuggestion).toHaveBeenCalledWith({
      learningReportId: learningReport.id,
      proposedPolicy: { positioning: "雨天出行建议（开头直接行动）" },
      rationale: "将有效开头写入账号蓝图。",
    });

    rerender(<LearningWorkspace {...workspaceProps({ episodes: [{ ...episode, stage: "learning_recorded" }], learningReports: [learningReport], blueprintChangeSuggestions: [blueprintChangeSuggestion], onApproveBlueprintChangeSuggestion })} />);
    await user.type(screen.getByLabelText("批准理由"), "确认写入后续生产单规则。");
    await user.click(screen.getByRole("button", { name: "批准并激活新蓝图版本" }));

    expect(onApproveBlueprintChangeSuggestion).toHaveBeenCalledWith({
      decisionReason: "确认写入后续生产单规则。",
      suggestionId: blueprintChangeSuggestion.id,
    });
  });
});
