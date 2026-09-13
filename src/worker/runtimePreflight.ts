import {
  parseWorkerPreflight,
  workerPreflightVersion,
  type WorkerPreflightAction,
  type WorkerPreflightCheck,
  type WorkerPreflightPhase,
  type WorkerPreflightResult,
  type WorkerPreflightScope,
  type WorkerPreflightStatus,
  type WorkerTaskPackage,
} from "./contracts.js";
import { credentialEnvironmentForReference, type RuntimeDependencyStatus } from "./runtimeEvidence.js";
import { mediaCapabilityForCapability, mediaCapabilityForKey, mediaCapabilityKeys } from "./productionCapabilities.js";
import { registeredAdapters, type ExecutionPath, type RegisteredAdapterChoice } from "./registeredAdapters.js";
import { workerRequiredTools } from "./runtimeConstraints.js";

export type RuntimePreflightSubject =
  | {
    kind: "account_blueprint";
    policy: unknown;
    seriesRules?: unknown;
    requiredMediaCapabilities?: readonly string[];
    target: "new_episode" | "existing_episode";
    accountId?: string;
  }
  | { kind: "worker_task"; taskPackage: WorkerTaskPackage };

export type RuntimeEvidenceKind =
  | "asset_root"
  | "command_availability"
  | "connection_reference"
  | "credential_presence"
  | "credential_validity"
  | "local_adapter_readiness"
  | "media_library"
  | "model_permission"
  | "network_connectivity";

export interface RuntimeEvidenceDemand {
  kind: RuntimeEvidenceKind;
  key: string;
  command?: string;
  provider?: string;
  adapter?: string;
  model?: string;
  credential?: string;
  credentialRef?: string;
}

export type RuntimeEvidenceFact = RuntimeEvidenceDemand & (
  | { state: "not_applicable" }
  | { state: "observed"; value: boolean | RuntimeDependencyStatus }
);

type ObservedRuntimeEvidenceFact = RuntimeEvidenceDemand & { state: "observed"; value: boolean | RuntimeDependencyStatus };

export interface RuntimeEvidenceAdapter {
  collect(request: { subject: RuntimePreflightSubject; demands: readonly RuntimeEvidenceDemand[] }): Promise<readonly RuntimeEvidenceFact[]>;
}

export interface PreflightIssue {
  action: WorkerPreflightAction;
  capability: string;
  check: string;
  phase: WorkerPreflightPhase;
  priority: 1 | 2 | 3 | 4;
  reason: string;
  scope: WorkerPreflightScope;
  status: Exclude<WorkerPreflightStatus, "passed">;
}

export interface PreflightDecision {
  report: WorkerPreflightResult;
  passed: boolean;
  issues: PreflightIssue[];
}

export interface RuntimePreflight {
  inspect(subject: RuntimePreflightSubject): Promise<PreflightDecision>;
  interpret(report: unknown): PreflightDecision;
}

export class RuntimeEvidenceFailure extends Error {
  readonly code: "collection_failed" | "conflicting_fact" | "missing_fact";

  constructor(code: RuntimeEvidenceFailure["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeEvidenceFailure";
    this.code = code;
  }
}

export function createRuntimePreflight(evidence: RuntimeEvidenceAdapter): RuntimePreflight {
  return {
    async inspect(subject) {
      const capabilities = capabilitiesFor(subject);
      const demands = evidenceDemands(subject, capabilities);
      let facts: readonly RuntimeEvidenceFact[];
      try {
        facts = await evidence.collect({ subject, demands });
      } catch (cause) {
        if (cause instanceof RuntimeEvidenceFailure) throw cause;
        throw new RuntimeEvidenceFailure("collection_failed", "运行前置条件证据收集失败。", { cause });
      }
      const ledger = createEvidenceLedger(demands, facts);
      return interpret(buildReport(subject, capabilities, ledger));
    },
    interpret,
  };
}

function interpret(value: unknown): PreflightDecision {
  const report = parseWorkerPreflight(value);
  const issues = report.checks.flatMap((check): PreflightIssue[] => check.status === "passed" ? [] : [{
    action: check.action,
    capability: check.capability,
    check: check.check,
    phase: check.phase,
    priority: priorityFor(check.action),
    reason: check.reason,
    scope: check.scope,
    status: check.status,
  }]);
  return { report, passed: issues.length === 0, issues };
}

function priorityFor(action: WorkerPreflightAction): PreflightIssue["priority"] {
  if (action === "edit_blueprint") return 1;
  if (action === "manage_connection") return 2;
  if (action === "retry") return 3;
  return 4;
}

interface RuntimeCapability {
  capability: string;
  executionPath?: ExecutionPath | "";
  provider: string;
  adapter?: string;
  model?: string;
  promptVersion?: string;
  promptHarnessId?: string;
  requiresAdapter?: boolean;
  requiresPromptHarness?: boolean;
  allowedTools?: unknown;
  credentialRef?: string;
  credential?: string;
  command?: string;
}

type ResolvedRuntimeCapability =
  | { kind: "configuration_error"; capability: RuntimeCapability; error: string }
  | { kind: "local_adapter"; capability: RuntimeCapability; registration: RegisteredAdapterChoice; readinessKey: string }
  | { kind: "unregistered_execution"; capability: RuntimeCapability }
  | { kind: "registered_execution"; capability: RuntimeCapability };

function capabilitiesFor(subject: RuntimePreflightSubject): RuntimeCapability[] {
  if (subject.kind === "worker_task") {
    const primary = runtimeCapabilityFromTask(subject.taskPackage);
    const imageGeneration = subject.taskPackage.visualAssetPreparation?.imageGeneration;
    if (!imageGeneration) return [primary];
    return [primary, {
      capability: "static_visual_generation",
      provider: imageGeneration.provider,
      adapter: imageGeneration.adapter,
      model: imageGeneration.model,
      promptVersion: subject.taskPackage.promptVersion,
      allowedTools: subject.taskPackage.allowedTools,
      credentialRef: imageGeneration.credentialRef,
    }];
  }
  return runtimeCapabilitiesFromBlueprintPolicy(subject.policy, subject.requiredMediaCapabilities);
}

function runtimeCapabilitiesFromBlueprintPolicy(policy: unknown, requiredMediaCapabilities?: readonly string[]): RuntimeCapability[] {
  const root = record(policy);
  const executors = record(root.executors);
  const required = requiredMediaCapabilities ? new Set(requiredMediaCapabilities) : undefined;
  const capabilities: RuntimeCapability[] = [
    capabilityFromExecutor("storyboard_planning", record(executors.storyboard_planning), "codex", { adapter: true, promptHarness: true }),
    { capability: "review_rendering", provider: "openchatcut", adapter: "openchatcut", model: "openchatcut@0.2.14", promptVersion: "review-render-v1", allowedTools: ["read", "write"], command: runtimeCommandForSelection({ capability: "review_rendering", provider: "openchatcut", adapter: "openchatcut" }) },
    { capability: "final_rendering", provider: "openchatcut", adapter: "openchatcut", model: "openchatcut@0.2.14", promptVersion: "final-render-v1", allowedTools: ["read", "write"], command: runtimeCommandForSelection({ capability: "final_rendering", provider: "openchatcut", adapter: "openchatcut" }) },
  ];
  for (const key of mediaCapabilityKeys) {
    const mediaCapability = mediaCapabilityForKey(key);
    const blueprintValue = root[key];
    if (blueprintValue === undefined || blueprintValue === null) continue;
    const config = record(blueprintValue);
    const executor = record(config.executor);
    const provider = stringValue(executor.provider);
    const adapter = stringValue(executor.adapter);
    const executionPath = stringValue(config.execution_path) as ExecutionPath | "";
    if (executionPath === "manual") continue;
    if (required ? !required.has(mediaCapability.capability) : Object.keys(config).length === 0) continue;
    const credentialRef = stringValue(config.credential_ref);
    const credential = credentialEnvironmentForReference(provider, adapter, credentialRef);
    capabilities.push({
      capability: mediaCapability.capability,
      executionPath,
      provider,
      adapter,
      model: stringValue(executor.model),
      promptVersion: stringValue(executor.prompt_version),
      allowedTools: requiredTools(),
      ...(credentialRef ? { credentialRef } : {}),
      ...(credential ? { credential } : {}),
      command: runtimeCommandForSelection({ capability: mediaCapability.capability, executionPath, provider, adapter }),
    });
  }
  return capabilities;
}

function runtimeCapabilityFromTask(taskPackage: WorkerTaskPackage): RuntimeCapability {
  const sharedPlanning = taskPackage.capability === "storyboard_planning";
  const adapter = taskPackage.capability === "acoustic_alignment" ? "whisperx_local" : taskPackage.aRoll?.adapter ?? taskPackage.media?.adapter ?? (taskPackage.provider === "codex" && (taskPackage.capability === "script_writing" || taskPackage.capability === "visual_planning") ? "codex" : sharedPlanning ? taskPackage.promptHarness?.adapter : undefined);
  const adapterResolution = registeredAdapters.resolve({ capability: taskPackage.capability, provider: taskPackage.provider, adapter });
  const executionPath = adapterResolution.kind === "registered" && adapterResolution.choice.executionPath === "local" ? "local" : undefined;
  return {
    capability: taskPackage.capability,
    ...(executionPath ? { executionPath } : {}),
    provider: taskPackage.provider,
    ...(adapter ? { adapter } : {}),
    model: taskPackage.model,
    promptVersion: taskPackage.promptVersion,
    ...(sharedPlanning && taskPackage.promptHarness ? { promptHarnessId: taskPackage.promptHarness.id } : {}),
    ...(sharedPlanning ? { requiresAdapter: true, requiresPromptHarness: true } : {}),
    allowedTools: taskPackage.allowedTools,
    ...(taskPackage.credentialRef ? { credentialRef: taskPackage.credentialRef } : {}),
    credential: credentialEnvironmentForReference(taskPackage.provider, adapter, taskPackage.credentialRef),
    command: adapterResolution.kind === "registered" ? runtimeCommandForExecution(adapterResolution.choice.execution.kind) : undefined,
  };
}

function evidenceDemands(subject: RuntimePreflightSubject, capabilities: readonly RuntimeCapability[]): RuntimeEvidenceDemand[] {
  const demands: RuntimeEvidenceDemand[] = [];
  for (const capability of capabilities) {
    const resolved = resolveRuntimeCapability(capability);
    if (resolved.kind === "local_adapter") {
      demands.push({ kind: "local_adapter_readiness", key: resolved.readinessKey, command: capability.command, provider: capability.provider, adapter: capability.adapter });
      continue;
    }
    if (resolved.kind !== "registered_execution") continue;
    if (capability.credential) demands.push({ kind: "credential_presence", key: capability.credential, credential: capability.credential, provider: capability.provider, adapter: capability.adapter });
    if (capability.credentialRef) {
      demands.push({ kind: "connection_reference", key: capability.credentialRef, credentialRef: capability.credentialRef, provider: capability.provider, adapter: capability.adapter, model: capability.model });
      demands.push({ kind: "credential_presence", key: capability.credentialRef, credentialRef: capability.credentialRef, provider: capability.provider, adapter: capability.adapter });
    }
    if (capability.command) demands.push({ kind: "command_availability", key: capability.command, command: capability.command });
    if (capability.model && (capability.provider === "codex" || capability.credential || capability.credentialRef)) demands.push({ kind: "model_permission", key: capability.model, provider: capability.provider, adapter: capability.adapter, model: capability.model, credential: capability.credential, credentialRef: capability.credentialRef });
    if (capability.provider === "codex" || capability.credential || capability.credentialRef) demands.push({ kind: "network_connectivity", key: capability.provider, provider: capability.provider, adapter: capability.adapter, model: capability.model, credential: capability.credential, credentialRef: capability.credentialRef });
    if (capability.credential || capability.credentialRef) demands.push({ kind: "credential_validity", key: capability.credential ?? capability.credentialRef!, provider: capability.provider, adapter: capability.adapter, model: capability.model, credential: capability.credential, credentialRef: capability.credentialRef });
  }
  demands.push({ kind: subject.kind === "account_blueprint" && subject.target === "new_episode" ? "media_library" : "asset_root", key: "worker_runtime" });
  return dedupeDemands(demands);
}

function dedupeDemands(demands: readonly RuntimeEvidenceDemand[]): RuntimeEvidenceDemand[] {
  const byId = new Map<string, RuntimeEvidenceDemand>();
  for (const demand of demands) if (!byId.has(demandId(demand))) byId.set(demandId(demand), demand);
  return [...byId.values()];
}

function createEvidenceLedger(demands: readonly RuntimeEvidenceDemand[], facts: readonly RuntimeEvidenceFact[]): ReadonlyMap<string, RuntimeEvidenceFact> {
  const expected = new Set(demands.map(demandId));
  const ledger = new Map<string, RuntimeEvidenceFact>();
  for (const fact of facts) {
    const id = demandId(fact);
    if (!expected.has(id)) continue;
    if (ledger.has(id)) throw new RuntimeEvidenceFailure("conflicting_fact", `运行前置条件证据冲突：${id}。`);
    ledger.set(id, fact);
  }
  for (const demand of demands) if (!ledger.has(demandId(demand))) throw new RuntimeEvidenceFailure("missing_fact", `运行前置条件缺少证据：${demandId(demand)}。`);
  return ledger;
}

function demandId(demand: Pick<RuntimeEvidenceDemand, "kind" | "key">): string {
  return `${demand.kind}:${demand.key}`;
}

function factFor(ledger: ReadonlyMap<string, RuntimeEvidenceFact>, kind: RuntimeEvidenceKind, key: string): ObservedRuntimeEvidenceFact | undefined {
  const fact = ledger.get(`${kind}:${key}`);
  return fact?.state === "observed" ? fact as ObservedRuntimeEvidenceFact : undefined;
}

function buildReport(subject: RuntimePreflightSubject, capabilities: readonly RuntimeCapability[], ledger: ReadonlyMap<string, RuntimeEvidenceFact>): WorkerPreflightResult {
  const checks: WorkerPreflightCheck[] = [];
  for (const capability of capabilities) {
    const resolved = resolveRuntimeCapability(capability);
    if (resolved.kind === "configuration_error") {
      checks.push({ capability: capability.capability, check: "blueprint_configuration", phase: "preflight", status: "blocked", reason: resolved.error, action: "edit_blueprint", scope: "blueprint" });
      continue;
    }
    if (resolved.kind === "local_adapter") {
      const fact = factFor(ledger, "local_adapter_readiness", resolved.readinessKey);
      if (fact && typeof fact.value !== "boolean") checks.push({ ...dependencyCheck(capability.capability, "local_adapter_readiness", fact.value), adapter: capability.adapter, provider: capability.provider });
      else checks.push({ adapter: capability.adapter, capability: capability.capability, check: "local_adapter_readiness", phase: "preflight", provider: capability.provider, status: "unavailable", reason: `本地 ${resolved.readinessKey} 尚未完成当前 Worker 就绪探测。`, action: "contact_environment_admin", scope: "worker" });
      continue;
    }
    if (resolved.kind === "unregistered_execution") {
      checks.push({ capability: capability.capability, check: "capability_registration", phase: "preflight", status: "unavailable", reason: `当前 Worker 未注册 ${capability.provider}/${capability.adapter ?? "default"} 执行路径。`, action: "contact_environment_admin", scope: "worker" });
      continue;
    }
    checks.push({ capability: capability.capability, check: "capability_registration", phase: "preflight", status: "passed", reason: `Worker 已注册 ${capability.provider}${capability.adapter ? `/${capability.adapter}` : ""} 执行路径。`, action: "none", scope: "worker" });
    const missingTools = requiredTools().filter((tool) => !stringArray(capability.allowedTools).includes(tool));
    checks.push(missingTools.length
      ? { capability: capability.capability, check: "tool_permission", phase: "preflight", status: "blocked", reason: `Worker 运行权限缺少 ${missingTools.join("、")}；请为当前 Worker 声明并授予对应文件能力。`, action: "contact_environment_admin", scope: "worker" }
      : { capability: capability.capability, check: "tool_permission", phase: "preflight", status: "passed", reason: `Worker 运行权限包含 ${requiredTools().join(" 和 ")}。`, action: "none", scope: "worker" });
    appendEvidenceChecks(checks, capability, ledger);
  }
  const runtimeKind = subject.kind === "account_blueprint" && subject.target === "new_episode" ? "media_library" : "asset_root";
  const runtimeFact = factFor(ledger, runtimeKind, "worker_runtime");
  if (runtimeFact && typeof runtimeFact.value !== "boolean") checks.push(dependencyCheck("worker_runtime", runtimeKind, runtimeFact.value));
  return { version: workerPreflightVersion, checks };
}

function appendEvidenceChecks(checks: WorkerPreflightCheck[], capability: RuntimeCapability, ledger: ReadonlyMap<string, RuntimeEvidenceFact>): void {
  if (capability.credential) appendCredentialPresence(checks, capability, ledger, capability.credential, false);
  if (capability.credentialRef) {
    const reference = statusFact(ledger, "connection_reference", capability.credentialRef);
    if (reference) checks.push(connectionReferenceCheck(capability.capability, reference));
    appendCredentialPresence(checks, capability, ledger, capability.credentialRef, true);
  }
  appendStatus(checks, capability, ledger, "command_availability", capability.command, dependencyCheck);
  const model = capability.model ? statusFact(ledger, "model_permission", capability.model) : undefined;
  if (model) checks.push(capability.provider === "openai" && capability.adapter === "openai_images" ? openAiModelPermissionCheck(capability.capability, model) : dependencyCheck(capability.capability, "model_permission", model));
  appendStatus(checks, capability, ledger, "network_connectivity", capability.provider, dependencyCheck);
  const credentialKey = capability.credential ?? capability.credentialRef;
  const validity = credentialKey ? statusFact(ledger, "credential_validity", credentialKey) : undefined;
  if (validity) checks.push(capability.credentialRef ? connectionCredentialValidityCheck(capability.capability, validity) : dependencyCheck(capability.capability, "credential_validity", validity));
}

function appendCredentialPresence(checks: WorkerPreflightCheck[], capability: RuntimeCapability, ledger: ReadonlyMap<string, RuntimeEvidenceFact>, key: string, connection: boolean): void {
  const fact = factFor(ledger, "credential_presence", key);
  if (!fact || typeof fact.value !== "boolean") return;
  checks.push({
    capability: capability.capability,
    check: "credential_presence",
    phase: "preflight",
    status: fact.value ? "passed" : "unavailable",
    reason: connection ? (fact.value ? "外部连接秘密已由 Worker 解析。" : "外部连接秘密不可用，请管理该连接。") : (fact.value ? `${key} 已在 Worker 环境中配置。` : `${key} 未配置。`),
    action: fact.value ? "none" : connection ? "manage_connection" : "contact_environment_admin",
    scope: connection ? "connection" : "worker",
  });
}

function appendStatus(checks: WorkerPreflightCheck[], capability: RuntimeCapability, ledger: ReadonlyMap<string, RuntimeEvidenceFact>, kind: RuntimeEvidenceKind, key: string | undefined, factory: typeof dependencyCheck): void {
  const status = key ? statusFact(ledger, kind, key) : undefined;
  if (status) checks.push(factory(capability.capability, kind, status));
}

function statusFact(ledger: ReadonlyMap<string, RuntimeEvidenceFact>, kind: RuntimeEvidenceKind, key: string): RuntimeDependencyStatus | undefined {
  const fact = factFor(ledger, kind, key);
  return fact && typeof fact.value !== "boolean" ? fact.value : undefined;
}

function resolveRuntimeCapability(capability: RuntimeCapability): ResolvedRuntimeCapability {
  const configurationError = configurationErrorFor(capability);
  if (configurationError) return { kind: "configuration_error", capability, error: configurationError };
  const resolution = registeredAdapters.resolve({ capability: capability.capability, executionPath: capability.executionPath, provider: capability.provider, adapter: capability.adapter, model: capability.model, preset: capability.promptVersion });
  if (resolution.kind !== "registered") return { kind: "unregistered_execution", capability };
  if (resolution.choice.executionPath === "local") return { kind: "local_adapter", capability, registration: resolution.choice, readinessKey: resolution.choice.identityKey };
  return { kind: "registered_execution", capability };
}

function runtimeCommandForSelection(selection: { adapter?: string; capability: string; executionPath?: ExecutionPath | ""; provider?: string }): string | undefined {
  const resolution = registeredAdapters.resolve(selection);
  return resolution.kind === "registered" ? runtimeCommandForExecution(resolution.choice.execution.kind) : undefined;
}

function runtimeCommandForExecution(kind: RegisteredAdapterChoice["execution"]["kind"]): string | undefined {
  if (kind === "codex") return "codex";
  if (kind === "ffmpeg") return "ffmpeg";
  if (kind === "openchatcut") return "openchatcut";
  if (kind === "whisperx") return process.env.WHISPERX_PYTHON?.trim() || "python3";
  return undefined;
}

function capabilityFromExecutor(capability: string, executor: Record<string, unknown>, defaultProvider: string, requirements: { adapter?: boolean; promptHarness?: boolean } = {}): RuntimeCapability {
  const provider = stringValue(executor.provider) || defaultProvider;
  const adapter = stringValue(executor.adapter);
  const promptHarnessId = stringValue(executor.harness_id);
  return { capability, provider, ...(adapter ? { adapter } : {}), model: stringValue(executor.model), promptVersion: stringValue(executor.prompt_version), ...(promptHarnessId ? { promptHarnessId } : {}), ...(requirements.adapter ? { requiresAdapter: true } : {}), ...(requirements.promptHarness ? { requiresPromptHarness: true } : {}), allowedTools: requiredTools(), command: runtimeCommandForSelection({ capability, provider, adapter }) };
}

function configurationErrorFor(capability: RuntimeCapability): string | undefined {
  if (mediaCapabilityForCapability(capability.capability) && capability.executionPath === "") return `能力 ${capability.capability} 缺少执行路径。`;
  if (!capability.provider || !capability.model || !capability.promptVersion) return `能力 ${capability.capability} 缺少 Provider、模型或 Prompt 版本。`;
  if (capability.requiresAdapter && !capability.adapter) return `能力 ${capability.capability} 缺少已注册 Adapter。`;
  const resolution = registeredAdapters.resolve({ capability: capability.capability, executionPath: capability.executionPath, provider: capability.provider, adapter: capability.adapter, model: capability.model, preset: capability.promptVersion });
  if (resolution.kind === "invalid" && (resolution.code === "model_unsupported" || resolution.code === "preset_unsupported" || resolution.code === "execution_path_mismatch" || resolution.code === "capability_unsupported")) return resolution.detail;
  if (resolution.kind === "registered" && resolution.choice.connection.kind === "owner_managed" && !isConnectionId(capability.credentialRef)) return `${capability.provider === "openai" ? "OpenAI Images" : capability.provider === "cloudflare" ? "Cloudflare Workers AI" : capability.provider === "google_tts" ? "Google TTS" : capability.provider === "volcengine_tts" ? "豆包语音" : capability.provider === "freesound" ? "Freesound" : "Pexels"} 必须选择已验证的外部连接版本。`;
  if (capability.requiresPromptHarness && !capability.promptHarnessId) return `能力 ${capability.capability} 缺少 Prompt Harness。`;
  return undefined;
}

function dependencyCheck(capability: string, check: string, dependency: RuntimeDependencyStatus): WorkerPreflightCheck {
  const status: WorkerPreflightStatus = dependency.available ? "passed" : dependency.status ?? "unavailable";
  return { capability, check, phase: "preflight", status, reason: dependency.detail, action: dependency.available ? "none" : status === "retryable" ? "retry" : "contact_environment_admin", scope: "worker" };
}

function connectionReferenceCheck(capability: string, dependency: RuntimeDependencyStatus): WorkerPreflightCheck {
  const status: WorkerPreflightStatus = dependency.available ? "passed" : dependency.status ?? "unavailable";
  return { capability, check: "connection_reference", phase: "preflight", status, reason: dependency.detail, action: dependency.available ? "none" : status === "retryable" ? "retry" : "manage_connection", scope: "connection" };
}

function connectionCredentialValidityCheck(capability: string, dependency: RuntimeDependencyStatus): WorkerPreflightCheck {
  const status: WorkerPreflightStatus = dependency.available ? "passed" : dependency.status ?? "unavailable";
  return { capability, check: "credential_validity", phase: "preflight", status, reason: dependency.detail, action: dependency.available ? "none" : status === "retryable" ? "retry" : "manage_connection", scope: status === "retryable" ? "worker" : "connection" };
}

function openAiModelPermissionCheck(capability: string, dependency: RuntimeDependencyStatus): WorkerPreflightCheck {
  const status: WorkerPreflightStatus = dependency.available ? "passed" : dependency.status ?? "unavailable";
  return { capability, check: "model_permission", phase: "preflight", status, reason: dependency.detail, action: dependency.available ? "none" : status === "retryable" ? "retry" : "edit_blueprint", scope: dependency.available || status === "retryable" ? "worker" : "blueprint" };
}

function requiredTools(): readonly string[] { return workerRequiredTools; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []; }
function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function isConnectionId(value: string | undefined): boolean { return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)); }
