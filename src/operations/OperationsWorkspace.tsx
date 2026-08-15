import { useMemo, useState } from "react";
import type { Database } from "../lib/database.types";
import type { EpisodeStage } from "../platform/types";
import { currentReviewPackage, isReviewPackagePending, workerBlockers } from "../reviews/reviewSelectors";

type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type PreRenderReviewMember = Database["public"]["Tables"]["pre_render_review_members"]["Row"];
type PreRenderReviewMemberDecision = Database["public"]["Tables"]["pre_render_review_member_decisions"]["Row"];
type ReviewPackage = Database["public"]["Tables"]["review_packages"]["Row"];
type Series = Database["public"]["Tables"]["series"]["Row"];
type SeriesVersion = Database["public"]["Tables"]["series_versions"]["Row"];
type Task = Database["public"]["Tables"]["tasks"]["Row"];

const stageGroups: Array<{ id: string; label: string; stages: EpisodeStage[] }> = [
  { id: "input", label: "输入与脚本", stages: ["waiting_input", "brief_draft", "script_draft", "script_review", "script_approved"] },
  { id: "visual", label: "视觉准备", stages: ["visual_draft", "visual_review", "visual_approved"] },
  { id: "storyboard", label: "分镜与媒体", stages: ["storyboard_draft", "storyboard_review", "storyboard_approved", "production_ready"] },
  { id: "render", label: "合成与 QC", stages: ["render_ready", "qc_review", "qc_passed"] },
  { id: "publish", label: "发布与复盘", stages: ["publish_ready", "publishing_review", "published", "metrics_collecting", "learning_recorded"] },
];

function operationalStageLabel(stage: EpisodeStage): string {
  return stageGroups.find((group) => group.stages.includes(stage))?.label ?? "未知阶段";
}

interface OperationalEpisode {
  episode: Episode;
  blockers: Array<{ code: string; detail: string; taskId: string }>;
  reviewPackage: ReviewPackage | null;
  reviewPending: boolean;
}

interface SeriesOperation {
  id: string;
  name: string;
  episodes: OperationalEpisode[];
}

export function OperationsWorkspace({ episodes, onSelectEpisode, preRenderReviewMemberDecisions, preRenderReviewMembers, reviewPackages, selectedEpisode, series, seriesVersions, tasks }: { episodes: Episode[]; onSelectEpisode: (episodeId: string) => void; preRenderReviewMemberDecisions: PreRenderReviewMemberDecision[]; preRenderReviewMembers: PreRenderReviewMember[]; reviewPackages: ReviewPackage[]; selectedEpisode: Episode | null; series: Series[]; seriesVersions: SeriesVersion[]; tasks: Task[] }) {
  const [selectedSeriesId, setSelectedSeriesId] = useState("all");
  const operations = useMemo<SeriesOperation[]>(() => {
    const seriesById = new Map(series.map((item) => [item.id, item]));
    const seriesVersionsById = new Map(seriesVersions.map((item) => [item.id, item]));
    const items = new Map<string, SeriesOperation>(series.map((item) => [item.id, { id: item.id, name: item.name, episodes: [] }]));
    const unassigned: SeriesOperation = { id: "unassigned", name: "未归属系列", episodes: [] };
    const unavailable: SeriesOperation = { id: "unavailable", name: "关联系列不可用", episodes: [] };

    for (const episode of episodes) {
      const version = episode.series_version_id ? seriesVersionsById.get(episode.series_version_id) : null;
      const operation = version && seriesById.has(version.series_id) ? items.get(version.series_id) : episode.series_version_id ? unavailable : unassigned;
      if (!operation) continue;
      const reviewPackage = currentReviewPackage(reviewPackages, episode);
      operation.episodes.push({
        episode,
        blockers: workerBlockers(tasks, episode.id).map((blocker) => ({ ...blocker, taskId: blocker.taskId ?? "unknown-task" })),
        reviewPackage,
        reviewPending: reviewPackage ? isReviewPackagePending(reviewPackage, preRenderReviewMembers, preRenderReviewMemberDecisions) : false,
      });
    }
    return [...items.values(), ...(unassigned.episodes.length ? [unassigned] : []), ...(unavailable.episodes.length ? [unavailable] : [])];
  }, [episodes, preRenderReviewMemberDecisions, preRenderReviewMembers, reviewPackages, series, seriesVersions, tasks]);
  const selectedOperation = selectedSeriesId === "all" ? null : operations.find((operation) => operation.id === selectedSeriesId) ?? null;
  const visibleOperations = selectedOperation ? [selectedOperation] : operations;
  const visibleEpisodes = visibleOperations.flatMap((operation) => operation.episodes);
  const pendingReviews = visibleEpisodes.filter((item) => item.reviewPending);
  const blockers = visibleEpisodes.flatMap((item) => item.blockers.map((blocker) => ({ ...blocker, episode: item.episode })));

  return <section className="operations-workspace" aria-label="系列运营概览">
    <header className="operations-intro"><div><h2>系列运营概览</h2><p>按生产单的当前阶段、待审包和 Worker 阻塞项汇总。这里不折算统一完成百分比。</p></div><label>系列<select aria-label="运营系列筛选" onChange={(event) => setSelectedSeriesId(event.target.value)} value={selectedSeriesId}><option value="all">全部系列</option>{operations.map((operation) => <option key={operation.id} value={operation.id}>{operation.name}</option>)}</select></label></header>

    <div className="operations-series-grid">{visibleOperations.map((operation) => {
      const operationReviews = operation.episodes.filter((item) => item.reviewPending).length;
      const operationBlockers = operation.episodes.flatMap((item) => item.blockers);
      return <button className={`operations-series-card ${selectedSeriesId === operation.id ? "is-selected" : ""}`} key={operation.id} onClick={() => setSelectedSeriesId(operation.id)} type="button"><strong>{operation.name}</strong><span>{operation.episodes.length} 个生产单</span><small>{operationReviews} 个待审核包 · {operationBlockers.length} 个阻塞项</small></button>;
    })}</div>

    <div className="operations-stage-grid" aria-label="阶段分布">{stageGroups.map((group) => <article key={group.id}><span>{group.label}</span><strong>{visibleEpisodes.filter((item) => group.stages.includes(item.episode.stage)).length}</strong><small>个生产单</small></article>)}</div>

    <div className="operations-detail-grid">
      <section className="operations-list"><header><h3>待审核</h3><span>{pendingReviews.length} 个待审核包</span></header>{pendingReviews.length ? <ul>{pendingReviews.map(({ episode, reviewPackage }) => <li key={episode.id}><button onClick={() => onSelectEpisode(episode.id)} type="button"><strong>{episode.title || "未命名生产单"}</strong><span>{operationalStageLabel(episode.stage)} · 审核包 v{reviewPackage?.revision_number}</span></button></li>)}</ul> : <p>当前筛选范围没有待审核包。</p>}</section>
      <section className="operations-list operations-blocker-list"><header><h3>阻塞项</h3><span>{blockers.length} 个阻塞项</span></header>{blockers.length ? <ul>{blockers.map((blocker) => <li key={`${blocker.taskId}-${blocker.code}`}><button onClick={() => onSelectEpisode(blocker.episode.id)} type="button"><strong>{blocker.episode.title || "未命名生产单"} · {blocker.code}</strong><span>{blocker.detail}</span></button></li>)}</ul> : <p>当前筛选范围没有 Worker 阻塞项。</p>}</section>
    </div>

    <section className="operations-episode-list" aria-label="系列生产单"><header><h3>生产单明细</h3><span>{visibleEpisodes.length} 个生产单</span></header>{visibleEpisodes.length ? <div>{visibleEpisodes.map(({ episode, blockers: episodeBlockers, reviewPackage, reviewPending }) => <button className={`operations-episode-row ${selectedEpisode?.id === episode.id ? "is-selected" : ""}`} key={episode.id} onClick={() => onSelectEpisode(episode.id)} type="button"><span><strong>{episode.title || "未命名生产单"}</strong><small>{episode.id.slice(0, 8)}</small></span><span>{operationalStageLabel(episode.stage)}</span><span>{reviewPending ? `待审 v${reviewPackage?.revision_number}` : reviewPackage ? `审核包 v${reviewPackage.revision_number} 已审完` : "无待审包"}</span><span>{episodeBlockers.length ? `${episodeBlockers.length} 个阻塞项` : "无阻塞"}</span></button>)}</div> : <p>当前没有可汇总的生产单。</p>}</section>
  </section>;
}
