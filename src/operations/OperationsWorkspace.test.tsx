import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../lib/database.types";
import { OperationsWorkspace } from "./OperationsWorkspace";

type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type ReviewPackage = Database["public"]["Tables"]["review_packages"]["Row"];
type Task = Database["public"]["Tables"]["tasks"]["Row"];

const series = { account_id: "account-1", created_at: "2026-08-15T00:00:00.000Z", id: "series-1", name: "雨夜志怪", updated_at: "2026-08-15T00:00:00.000Z" } as Database["public"]["Tables"]["series"]["Row"];
const seriesVersion = { account_id: "account-1", created_at: "2026-08-15T00:00:00.000Z", id: "series-version-1", rules: {}, series_id: series.id, version: 2 } as Database["public"]["Tables"]["series_versions"]["Row"];

const episodes: Episode[] = [
  { account_id: "account-1", blueprint_version_id: "blueprint-1", created_at: "2026-08-15T00:00:00.000Z", id: "episode-review", series_version_id: seriesVersion.id, stage: "script_review", title: "脚本待审", updated_at: "2026-08-15T00:00:00.000Z" },
  { account_id: "account-1", blueprint_version_id: "blueprint-1", created_at: "2026-08-15T00:00:00.000Z", id: "episode-blocked", series_version_id: seriesVersion.id, stage: "production_ready", title: "媒体受阻", updated_at: "2026-08-15T00:00:00.000Z" },
  { account_id: "account-1", blueprint_version_id: "blueprint-1", created_at: "2026-08-15T00:00:00.000Z", id: "episode-unassigned", series_version_id: null, stage: "published", title: "无系列生产单", updated_at: "2026-08-15T00:00:00.000Z" },
];

const reviewPackages: ReviewPackage[] = [
  { artifact_id: null, context_snapshot: {}, created_at: "2026-08-15T00:00:00.000Z", episode_id: "episode-review", id: "old-script-review", invalidated_at: null, invalidated_reason: null, revision_number: 1, stage: "script_review", task_id: "task-old", task_run_id: "run-old" },
  { artifact_id: null, context_snapshot: {}, created_at: "2026-08-15T00:01:00.000Z", episode_id: "episode-review", id: "new-script-review", invalidated_at: null, invalidated_reason: null, revision_number: 2, stage: "script_review", task_id: "task-new", task_run_id: "run-new" },
  { artifact_id: null, context_snapshot: {}, created_at: "2026-08-15T00:01:00.000Z", episode_id: "episode-blocked", id: "stale-visual-review", invalidated_at: null, invalidated_reason: null, revision_number: 1, stage: "visual_review", task_id: "task-stale", task_run_id: "run-stale" },
];

const tasks: Task[] = [{ actual_cost_cents: null, attempt: 0, budget_limit_cents: 0, claimed_at: null, completed_at: null, created_at: "2026-08-15T00:00:00.000Z", episode_id: "episode-blocked", id: "blocked-task", input_snapshot: {}, last_result: { blockers: [{ code: "media_provider_unavailable", detail: "测试媒体适配器未配置。" }] }, max_attempts: 1, model: "", prompt_version: "", provider: "", status: "blocked", task_type: "generate_b_roll" }];

describe("系列运营视图", () => {
  it("按当前生产单阶段汇总系列，并且不显示统一完成百分比", () => {
    render(<OperationsWorkspace episodes={episodes} preRenderReviewMemberDecisions={[]} preRenderReviewMembers={[]} reviewPackages={reviewPackages} series={[series]} seriesVersions={[seriesVersion]} tasks={tasks} onSelectEpisode={vi.fn()} selectedEpisode={null} />);

    expect(screen.getByRole("button", { name: /雨夜志怪/ })).toBeTruthy();
    expect(screen.getAllByText("输入与脚本").length).toBeGreaterThan(0);
    expect(screen.getAllByText("分镜与媒体").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\d+%/)).toBeNull();
  });

  it("只计入当前阶段的最新待审包，并可定位待审和阻塞生产单", async () => {
    const user = userEvent.setup();
    const onSelectEpisode = vi.fn();
    render(<OperationsWorkspace episodes={episodes} preRenderReviewMemberDecisions={[]} preRenderReviewMembers={[]} reviewPackages={reviewPackages} series={[series]} seriesVersions={[seriesVersion]} tasks={tasks} onSelectEpisode={onSelectEpisode} selectedEpisode={null} />);

    expect(screen.getByText("1 个待审核包")).toBeTruthy();
    expect(screen.getByText("测试媒体适配器未配置。")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "脚本待审 输入与脚本 · 审核包 v2" }));
    await user.click(screen.getByRole("button", { name: "媒体受阻 · media_provider_unavailable 测试媒体适配器未配置。" }));
    expect(onSelectEpisode).toHaveBeenNthCalledWith(1, "episode-review");
    expect(onSelectEpisode).toHaveBeenNthCalledWith(2, "episode-blocked");
  });

  it("不把已逐项批准的预渲染包计为待审核，并保留缺失系列关联的生产单", () => {
    const productionEpisode = { ...episodes[1], id: "episode-production", series_version_id: "missing-series-version", stage: "production_ready" as const, title: "预渲染已审核" };
    const productionPackage = { ...reviewPackages[0], episode_id: productionEpisode.id, id: "pre-render-package", revision_number: 1, stage: "production_ready" as const };
    const member = { artifact_id: null, audio_track_id: null, created_at: "2026-08-15T00:00:00.000Z", evidence_snapshot: {}, id: "pre-render-member", member_key: "shot:shot-01", member_kind: "shot_media", review_package_id: productionPackage.id, source_task_id: "task-media" } as Database["public"]["Tables"]["pre_render_review_members"]["Row"];
    const decision = { actor_id: "owner-1", created_at: "2026-08-15T00:00:00.000Z", decision: "approved", inherited_from_review_package_id: null, member_key: member.member_key, reason: "已审完。", review_package_id: productionPackage.id } as Database["public"]["Tables"]["pre_render_review_member_decisions"]["Row"];

    render(<OperationsWorkspace episodes={[productionEpisode]} preRenderReviewMemberDecisions={[decision]} preRenderReviewMembers={[member]} reviewPackages={[productionPackage]} series={[]} seriesVersions={[]} tasks={[]} onSelectEpisode={vi.fn()} selectedEpisode={null} />);

    expect(screen.getByRole("button", { name: /关联系列不可用/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /0 个待审核包/ })).toBeTruthy();
    expect(screen.getByText("0 个待审核包")).toBeTruthy();
    expect(screen.getByText("审核包 v1 已审完")).toBeTruthy();
  });
});
