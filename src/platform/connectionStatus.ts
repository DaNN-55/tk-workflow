import type { Json } from "../lib/database.types";
import type { WorkerPreflightAction, WorkerPreflightResult, WorkerPreflightStatus } from "../worker/contracts";
import { blueprintPolicyToForm, type ConfigurableMediaAdapterKey } from "./configurationFormValues";
import { mediaCapabilityForKey } from "../worker/productionCapabilities";
import { registeredAdapters } from "../worker/registeredAdapters";

export type ExternalConnectionStatus = {
  action: WorkerPreflightAction;
  adapter: string;
  capability: string;
  check: string | null;
  key: ConfigurableMediaAdapterKey;
  provider: string;
  reason: string;
  status: WorkerPreflightStatus | "pending";
};

export function externalConnectionStatuses(policy: Json, preflight: WorkerPreflightResult | null): ExternalConnectionStatus[] {
  const form = blueprintPolicyToForm(policy);
  return (form.enabledMediaAdapters ?? []).filter((key) => registeredAdapters.resolve({ capability: mediaCapabilityForKey(key).capability, executionPath: "external", provider: form.mediaAdapters[key].provider, adapter: form.mediaAdapters[key].adapter }).kind === "registered").map((key) => {
    const capability = mediaCapabilityForKey(key).capability;
    const checks = preflight?.checks.filter((check) => check.capability === capability) ?? [];
    const failedCheck = checks.find((check) => check.status !== "passed");
    const adapter = form.mediaAdapters[key];
    return {
      action: failedCheck?.action ?? "none",
      adapter: adapter.adapter,
      capability,
      check: failedCheck?.check ?? null,
      key,
      provider: adapter.provider,
      reason: failedCheck?.reason ?? (checks.length ? "Worker 已通过当前连接检查。" : "尚未执行连接检查。"),
      status: failedCheck?.status ?? (checks.length ? "passed" : "pending"),
    };
  });
}
