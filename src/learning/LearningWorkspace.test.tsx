import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../lib/database.types";
import { LearningWorkspace } from "./LearningWorkspace";

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

describe("复盘工作台", () => {
  it("为生产单定义一个主指标和最多两个护栏指标", async () => {
    const user = userEvent.setup();
    const onSaveExperiment = vi.fn().mockResolvedValue(undefined);

    render(<LearningWorkspace accountsById={new Map()} episodes={[episode]} experiments={[]} metricSnapshots={[]} onSaveExperiment={onSaveExperiment} onSaveMetricSnapshot={vi.fn()} />);

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

    render(<LearningWorkspace accountsById={new Map()} episodes={[episode]} experiments={[experiment]} metricSnapshots={[]} onSaveExperiment={vi.fn()} onSaveMetricSnapshot={onSaveMetricSnapshot} />);

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
    render(<LearningWorkspace accountsById={new Map()} episodes={[{ ...episode, stage: "learning_recorded" }]} experiments={[experiment]} metricSnapshots={[]} onSaveExperiment={vi.fn()} onSaveMetricSnapshot={vi.fn()} />);

    expect(screen.getByText("实验定义")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存本周指标" })).toBeNull();
  });
});
