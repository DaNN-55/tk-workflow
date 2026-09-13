import { registeredAdapters } from "./registeredAdapters.js";

export const workerRequiredTools = ["read", "write"] as const;

export interface WorkerRuntimeConstraints {
  adapterSafetyLimit: number;
  effectiveConcurrency: number;
  providerOrConnectionLimit: number | null;
  workerCapacity: number;
}

export function workerRuntimeConstraints({ adapter, capability, provider, providerOrConnectionLimit = null, workerCapacity = 1 }: { adapter?: string; capability?: string; provider?: string; providerOrConnectionLimit?: number | null; workerCapacity?: number }): WorkerRuntimeConstraints {
  const resolution = registeredAdapters.resolve({ adapter, capability: capability ?? "", provider });
  const adapterSafetyLimit = resolution.kind === "registered" ? resolution.choice.execution.safetyLimit : 1;
  const safeWorkerCapacity = Number.isInteger(workerCapacity) && workerCapacity > 0 ? workerCapacity : 1;
  const safeProviderLimit = providerOrConnectionLimit !== null && Number.isInteger(providerOrConnectionLimit) && providerOrConnectionLimit > 0 ? providerOrConnectionLimit : null;
  return {
    adapterSafetyLimit,
    effectiveConcurrency: Math.min(safeProviderLimit ?? adapterSafetyLimit, adapterSafetyLimit, safeWorkerCapacity),
    providerOrConnectionLimit: safeProviderLimit,
    workerCapacity: safeWorkerCapacity,
  };
}
