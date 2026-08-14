import type { AuditEvent, Episode, ProductionMaterialRevision, Task } from "./types";

export interface PlatformRepository {
  createEpisode(episode: Episode): Promise<void>;
  getEpisode(id: string): Promise<Episode | null>;
  updateEpisode(episode: Episode): Promise<void>;
  listEpisodes(): Promise<Episode[]>;
  createTask(task: Task): Promise<void>;
  listTasks(episodeId: string): Promise<Task[]>;
  createAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(episodeId: string): Promise<AuditEvent[]>;
  createMaterialRevision(revision: ProductionMaterialRevision): Promise<void>;
  listMaterialRevisions(episodeId: string): Promise<ProductionMaterialRevision[]>;
}
