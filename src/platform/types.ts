export const episodeStages = [
  "brief_draft",
  "script_draft",
  "script_review",
  "script_approved",
  "visual_draft",
  "visual_review",
  "visual_approved",
  "storyboard_draft",
  "storyboard_review",
  "storyboard_approved",
  "production_ready",
  "render_ready",
  "qc_review",
  "qc_passed",
  "publish_ready",
  "publishing_review",
  "published",
  "metrics_collecting",
  "learning_recorded",
] as const;

export type EpisodeStage = (typeof episodeStages)[number];

export type ActorRole = "owner" | "worker";

export interface Actor {
  id: string;
  role: ActorRole;
}

export interface Episode {
  id: string;
  accountId: string;
  blueprintVersionId: string;
  title: string;
  status: EpisodeStage;
  createdAt: string;
  updatedAt: string;
}

export type TaskType = "draft_brief";
export type TaskStatus = "ready" | "completed" | "blocked";

export interface Task {
  id: string;
  episodeId: string;
  type: TaskType;
  status: TaskStatus;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  episodeId: string;
  actorId: string;
  type: "episode_created" | "stage_transition";
  from: EpisodeStage | null;
  to: EpisodeStage | null;
  reason: string;
  createdAt: string;
}

export interface CreateEpisodeInput {
  accountId: string;
  blueprintVersionId: string;
  title: string;
}

export interface TransitionEpisodeInput {
  episodeId: string;
  actor: Actor;
  to: EpisodeStage;
  reason: string;
}
