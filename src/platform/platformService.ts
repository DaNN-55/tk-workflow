import type { PlatformRepository } from "./repository";
import type {
  AuditEvent,
  CreateEpisodeInput,
  Episode,
  EpisodeStage,
  Task,
  TransitionEpisodeInput,
} from "./types";

const allowedTransitions: Readonly<Record<EpisodeStage, readonly EpisodeStage[]>> = {
  brief_draft: ["script_draft"],
  script_draft: ["script_review"],
  script_review: ["script_draft", "script_approved"],
  script_approved: ["visual_draft"],
  visual_draft: ["visual_review"],
  visual_review: ["visual_draft", "visual_approved"],
  visual_approved: ["storyboard_draft"],
  storyboard_draft: ["storyboard_review"],
  storyboard_review: ["storyboard_draft", "storyboard_approved"],
  storyboard_approved: ["production_ready"],
  production_ready: ["render_ready"],
  render_ready: ["qc_review"],
  qc_review: ["render_ready", "qc_passed"],
  qc_passed: ["publish_ready"],
  publish_ready: ["publishing_review"],
  publishing_review: ["publish_ready", "published"],
  published: ["metrics_collecting"],
  metrics_collecting: ["learning_recorded"],
  learning_recorded: [],
};

const ownerOnlyStages = new Set<EpisodeStage>([
  "script_approved",
  "visual_approved",
  "storyboard_approved",
  "qc_passed",
  "publish_ready",
  "published",
]);

export class InvalidTransitionError extends Error {
  constructor(from: EpisodeStage, to: EpisodeStage) {
    super(`Cannot transition episode from ${from} to ${to}.`);
    this.name = "InvalidTransitionError";
  }
}

export class AuthorizationError extends Error {
  constructor(stage: EpisodeStage) {
    super(`Only an owner can transition an episode to ${stage}.`);
    this.name = "AuthorizationError";
  }
}

export class EpisodeNotFoundError extends Error {
  constructor(id: string) {
    super(`Episode ${id} was not found.`);
    this.name = "EpisodeNotFoundError";
  }
}

export interface PlatformService {
  createEpisode(input: CreateEpisodeInput): Promise<Episode>;
  transitionEpisode(input: TransitionEpisodeInput): Promise<Episode>;
  listEpisodes(): Promise<Episode[]>;
  listTasks(episodeId: string): Promise<Task[]>;
  listAuditEvents(episodeId: string): Promise<AuditEvent[]>;
}

export function createPlatformService(repository: PlatformRepository): PlatformService {
  return {
    async createEpisode(input) {
      const now = new Date().toISOString();
      const episode: Episode = {
        id: crypto.randomUUID(),
        accountId: input.accountId,
        blueprintVersionId: input.blueprintVersionId,
        title: input.title,
        status: "brief_draft",
        createdAt: now,
        updatedAt: now,
      };
      const task: Task = {
        id: crypto.randomUUID(),
        episodeId: episode.id,
        type: "draft_brief",
        status: "ready",
        createdAt: now,
      };

      await repository.createEpisode(episode);
      await repository.createTask(task);
      await repository.createAuditEvent({
        id: crypto.randomUUID(),
        episodeId: episode.id,
        actorId: "system",
        type: "episode_created",
        from: null,
        to: "brief_draft",
        reason: "Episode created from its fixed blueprint version.",
        createdAt: now,
      });

      return episode;
    },
    async transitionEpisode(input) {
      const episode = await repository.getEpisode(input.episodeId);
      if (!episode) {
        throw new EpisodeNotFoundError(input.episodeId);
      }
      if (!allowedTransitions[episode.status].includes(input.to)) {
        throw new InvalidTransitionError(episode.status, input.to);
      }
      if (ownerOnlyStages.has(input.to) && input.actor.role !== "owner") {
        throw new AuthorizationError(input.to);
      }

      const updatedAt = new Date().toISOString();
      const updatedEpisode: Episode = { ...episode, status: input.to, updatedAt };
      await repository.updateEpisode(updatedEpisode);
      await repository.createAuditEvent({
        id: crypto.randomUUID(),
        episodeId: episode.id,
        actorId: input.actor.id,
        type: "stage_transition",
        from: episode.status,
        to: input.to,
        reason: input.reason,
        createdAt: updatedAt,
      });

      return updatedEpisode;
    },
    listEpisodes: () => repository.listEpisodes(),
    listTasks: (episodeId) => repository.listTasks(episodeId),
    listAuditEvents: (episodeId) => repository.listAuditEvents(episodeId),
  };
}
