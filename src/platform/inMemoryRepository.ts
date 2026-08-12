import type { PlatformRepository } from "./repository";
import type { AuditEvent, Episode, Task } from "./types";

export function createInMemoryPlatformRepository(): PlatformRepository {
  const episodes = new Map<string, Episode>();
  const tasks = new Map<string, Task[]>();
  const auditEvents = new Map<string, AuditEvent[]>();

  return {
    async createEpisode(episode) {
      episodes.set(episode.id, episode);
    },
    async getEpisode(id) {
      return episodes.get(id) ?? null;
    },
    async updateEpisode(episode) {
      episodes.set(episode.id, episode);
    },
    async listEpisodes() {
      return [...episodes.values()];
    },
    async createTask(task) {
      const episodeTasks = tasks.get(task.episodeId) ?? [];
      episodeTasks.push(task);
      tasks.set(task.episodeId, episodeTasks);
    },
    async listTasks(episodeId) {
      return tasks.get(episodeId) ?? [];
    },
    async createAuditEvent(event) {
      const episodeEvents = auditEvents.get(event.episodeId) ?? [];
      episodeEvents.push(event);
      auditEvents.set(event.episodeId, episodeEvents);
    },
    async listAuditEvents(episodeId) {
      return auditEvents.get(episodeId) ?? [];
    },
  };
}
