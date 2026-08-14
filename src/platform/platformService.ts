import type { PlatformRepository } from "./repository";
import type {
  AuditEvent,
  CreateEpisodeInput,
  Episode,
  EpisodeStage,
  ImportMaterialInput,
  ProductionMaterialRevision,
  Task,
  TransitionEpisodeInput,
} from "./types";

const allowedTransitions: Readonly<Record<EpisodeStage, readonly EpisodeStage[]>> = {
  waiting_input: ["script_draft", "script_approved"],
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
  listEpisodes(filter?: { seriesVersionId?: string | null }): Promise<Episode[]>;
  listTasks(episodeId: string): Promise<Task[]>;
  listAuditEvents(episodeId: string): Promise<AuditEvent[]>;
  importMaterial(input: ImportMaterialInput): Promise<ProductionMaterialRevision>;
  listMaterialRevisions(episodeId: string): Promise<ProductionMaterialRevision[]>;
  updateEpisodeTitle(episodeId: string, title: string): Promise<Episode>;
}

async function sha256Hex(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", content.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPlatformService(repository: PlatformRepository): PlatformService {
  return {
    async createEpisode(input) {
      const now = new Date().toISOString();
      const episode: Episode = {
        id: crypto.randomUUID(),
        accountId: input.accountId,
        blueprintVersionId: input.blueprintVersionId,
        seriesVersionId: input.seriesVersionId ?? null,
        title: input.title,
        status: "waiting_input",
        createdAt: now,
        updatedAt: now,
      };
      await repository.createEpisode(episode);
      await repository.createAuditEvent({
        id: crypto.randomUUID(),
        episodeId: episode.id,
        actorId: "system",
        type: "episode_created",
        from: null,
        to: "waiting_input",
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
    async listEpisodes(filter) {
      const episodes = await repository.listEpisodes();
      return filter && "seriesVersionId" in filter
        ? episodes.filter((episode) => episode.seriesVersionId === filter.seriesVersionId)
        : episodes;
    },
    listTasks: (episodeId) => repository.listTasks(episodeId),
    listAuditEvents: (episodeId) => repository.listAuditEvents(episodeId),
    async importMaterial(input) {
      const episode = await repository.getEpisode(input.episodeId);
      if (!episode) throw new EpisodeNotFoundError(input.episodeId);
      const content = input.content.slice();
      const sha256 = await sha256Hex(content);
      const sourceName = input.sourcePath.split(/[\\/]/).pop() || "material.bin";
      const revision: ProductionMaterialRevision = {
        id: crypto.randomUUID(),
        episodeId: input.episodeId,
        materialType: input.materialType,
        sourceKind: input.sourceKind,
        sourcePath: input.sourcePath,
        storagePath: `episodes/${input.episodeId}/materials/${sha256}-${sourceName}`,
        content,
        mimeType: input.mimeType,
        sha256,
        fileSize: content.byteLength,
        isMainScript: input.isMainScript,
        createdAt: new Date().toISOString(),
      };
      await repository.createMaterialRevision(revision);
      if (input.isMainScript && episode.status === "waiting_input") {
        await repository.updateEpisode({ ...episode, status: "script_approved", updatedAt: revision.createdAt });
      }
      return { ...revision, content: revision.content.slice() };
    },
    listMaterialRevisions: (episodeId) => repository.listMaterialRevisions(episodeId),
    async updateEpisodeTitle(episodeId, title) {
      const episode = await repository.getEpisode(episodeId);
      if (!episode) throw new EpisodeNotFoundError(episodeId);
      const updatedEpisode = { ...episode, title, updatedAt: new Date().toISOString() };
      await repository.updateEpisode(updatedEpisode);
      return updatedEpisode;
    },
  };
}
