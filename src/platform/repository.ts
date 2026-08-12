import type { AuditEvent, Episode, Task } from "./types";

export interface PlatformRepository {
  createEpisode(episode: Episode): Promise<void>;
  getEpisode(id: string): Promise<Episode | null>;
  updateEpisode(episode: Episode): Promise<void>;
  listEpisodes(): Promise<Episode[]>;
  createTask(task: Task): Promise<void>;
  listTasks(episodeId: string): Promise<Task[]>;
  createAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(episodeId: string): Promise<AuditEvent[]>;
}
