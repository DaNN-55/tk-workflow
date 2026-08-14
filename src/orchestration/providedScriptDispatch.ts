export interface ProvidedScriptDispatchDependencies<TTask, TWorkerResult> {
  planTasks(): Promise<TTask[]>;
  runWorker(): Promise<TWorkerResult>;
}

export async function dispatchProvidedScriptWork<TTask, TWorkerResult>(dependencies: ProvidedScriptDispatchDependencies<TTask, TWorkerResult>): Promise<{ plannedTasks: number; worker: TWorkerResult }> {
  const tasks = await dependencies.planTasks();
  const worker = await dependencies.runWorker();
  return { plannedTasks: tasks.length, worker };
}
