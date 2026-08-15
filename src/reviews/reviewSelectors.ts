import type { Database, Json } from "../lib/database.types";

type Episode = Database["public"]["Tables"]["episodes"]["Row"];
type PreRenderReviewMember = Database["public"]["Tables"]["pre_render_review_members"]["Row"];
type PreRenderReviewMemberDecision = Database["public"]["Tables"]["pre_render_review_member_decisions"]["Row"];
type ReviewPackage = Database["public"]["Tables"]["review_packages"]["Row"];
type Task = Database["public"]["Tables"]["tasks"]["Row"];

export interface WorkerBlocker {
  code: string;
  detail: string;
  taskId?: string;
}

export function currentReviewPackage(reviewPackages: ReviewPackage[], episode: Episode): ReviewPackage | null {
  return reviewPackages
    .filter((candidate) => candidate.episode_id === episode.id && candidate.stage === episode.stage && !candidate.invalidated_at)
    .reduce<ReviewPackage | null>((latest, candidate) => !latest || candidate.revision_number > latest.revision_number ? candidate : latest, null);
}

export function blockersFromResult(result: Json | null): WorkerBlocker[] {
  if (!result || Array.isArray(result) || typeof result !== "object" || !("blockers" in result) || !Array.isArray(result.blockers)) return [];
  return result.blockers.flatMap((blocker) => {
    if (!blocker || Array.isArray(blocker) || typeof blocker !== "object") return [];
    const { code, detail } = blocker;
    return typeof code === "string" && code && typeof detail === "string" && detail ? [{ code, detail }] : [];
  });
}

export function workerBlockers(tasks: Task[], episodeId: string): WorkerBlocker[] {
  return tasks
    .filter((task) => task.episode_id === episodeId && task.status === "blocked")
    .flatMap((task) => blockersFromResult(task.last_result).map((blocker) => ({ ...blocker, taskId: task.id })));
}

export function isReviewPackagePending(reviewPackage: ReviewPackage, members: PreRenderReviewMember[], decisions: PreRenderReviewMemberDecision[]): boolean {
  if (reviewPackage.stage !== "production_ready") return true;
  const packageMembers = members.filter((member) => member.review_package_id === reviewPackage.id);
  return packageMembers.length === 0 || packageMembers.some((member) => !decisions.some((decision) => decision.review_package_id === reviewPackage.id && decision.member_key === member.member_key));
}
