import type { Database } from "../lib/database.types";
import { supabase } from "../lib/supabase";

type Task = Database["public"]["Tables"]["tasks"]["Row"];
type TaskRun = Pick<Database["public"]["Tables"]["task_runs"]["Row"], "attempt" | "completed_at" | "id" | "started_at" | "status" | "task_id">;
type TaskStatusProbe = Pick<Task, "attempt" | "completed_at" | "episode_id" | "id" | "last_result" | "status">;

function taskStatusSignature(task: Pick<Task, "attempt" | "completed_at" | "last_result" | "status">): string {
  return `${task.status}:${task.attempt}:${task.completed_at ?? ""}:${JSON.stringify(task.last_result)}`;
}

function taskRunStatusSignature(run: TaskRun): string {
  return `${run.status}:${run.attempt}:${run.completed_at ?? ""}:${run.started_at}`;
}

export function episodeNeedsTaskPolling(input: { detailOpen: boolean; dispatchRequested: boolean; hasActiveTask: boolean; pageVisible: boolean }): boolean {
  return input.detailOpen && input.pageVisible && (input.dispatchRequested || input.hasActiveTask);
}

export function episodeTaskStatusChanged(previousTasks: Task[], nextTasks: TaskStatusProbe[], episodeId: string): boolean {
  const currentTasks = previousTasks.filter((task) => task.episode_id === episodeId);
  if (currentTasks.length !== nextTasks.length) return true;
  const currentById = new Map(currentTasks.map((task) => [task.id, task]));
  return nextTasks.some((task) => {
    const current = currentById.get(task.id);
    return !current || taskStatusSignature(task) !== taskStatusSignature(current);
  });
}

export function episodeTaskRunStatusChanged(previousRuns: TaskRun[], nextRuns: TaskRun[], taskIds: Set<string>): boolean {
  const currentRuns = previousRuns.filter((run) => taskIds.has(run.task_id));
  if (currentRuns.length !== nextRuns.length) return true;
  const currentById = new Map(currentRuns.map((run) => [run.id, run]));
  return nextRuns.some((run) => {
    const current = currentById.get(run.id);
    return !current || taskRunStatusSignature(run) !== taskRunStatusSignature(current);
  });
}

export function mergeEpisodeTaskStatus(previous: { tasks: Task[]; taskRuns: TaskRun[] }, episodeId: string, tasks: Task[], taskRuns: TaskRun[]): { tasks: Task[]; taskRuns: TaskRun[] } {
  const previousTaskIds = new Set(previous.tasks.filter((task) => task.episode_id === episodeId).map((task) => task.id));
  return {
    tasks: [...previous.tasks.filter((task) => task.episode_id !== episodeId), ...tasks],
    taskRuns: [...previous.taskRuns.filter((run) => !previousTaskIds.has(run.task_id)), ...taskRuns],
  };
}

async function requestImmediateTaskDispatch(episodeId: string, taskId: string): Promise<{ accepted: boolean; reason: string }> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) return { accepted: false, reason: "Owner 登录会话不可用" };
  const response = await fetch(`/_episode-dispatch?${new URLSearchParams({ episode: episodeId, task: taskId }).toString()}`, {
    headers: { Authorization: `Bearer ${data.session.access_token}` },
    method: "POST",
  }).catch(() => null);
  if (!response) return { accepted: false, reason: "即时派发服务不可用" };
  if (!response.ok) return { accepted: false, reason: (await response.text()).trim() || "Worker 未能启动" };
  return { accepted: true, reason: "" };
}

export async function dispatchCreatedWorkerTask(episodeId: string, task: { id?: string } | null | undefined, dispatch: (episodeId: string, taskId: string) => Promise<{ accepted: boolean; reason: string }> = requestImmediateTaskDispatch): Promise<{ accepted: boolean; reason: string }> {
  return task?.id ? dispatch(episodeId, task.id) : { accepted: false, reason: "任务记录缺少 ID" };
}
