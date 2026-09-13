import { workerPreflightVersion, type WorkerPreflightCheck, type WorkerPreflightResult, type WorkerPreflightStatus, type WorkerTaskPackage } from "./contracts.js";
import { mediaCapabilityForCapability, mediaCapabilityForKey, mediaCapabilityKeys } from "./productionCapabilities.js";
import { registeredAdapters, type ExecutionPath, type RegisteredAdapterChoice } from "./registeredAdapters.js";
import { workerRequiredTools } from "./runtimeConstraints.js";

export interface RuntimeCapability {
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

export interface RuntimeDependencyStatus {
  available: boolean;
  detail: string;
  status?: "retryable" | "unavailable";
}

export interface RuntimePreflightEnvironment {
  assetRoot?: RuntimeDependencyStatus;
  credentials?: Record<string, boolean>;
  connectionReferences?: Record<string, RuntimeDependencyStatus>;
  credentialValidity?: Record<string, RuntimeDependencyStatus>;
  commands?: Record<string, RuntimeDependencyStatus>;
  connections?: Record<string, RuntimeDependencyStatus>;
  mediaLibrary?: RuntimeDependencyStatus;
  localAdapters?: Record<string, RuntimeDependencyStatus>;
  modelPermissions?: Record<string, RuntimeDependencyStatus>;
}

export type ResolvedRuntimeCapability =
  | { kind: "configuration_error"; capability: RuntimeCapability; error: string }
  | { kind: "local_adapter"; capability: RuntimeCapability; registration: RegisteredAdapterChoice; readinessKey: string }
  | { kind: "unregistered_execution"; capability: RuntimeCapability }
  | { kind: "registered_execution"; capability: RuntimeCapability };

export function runtimeCapabilitiesFromBlueprintPolicy(policy: unknown, _seriesRules?: unknown, requiredMediaCapabilities?: readonly string[]): RuntimeCapability[] {
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

export function runtimeCapabilityFromTask(taskPackage: WorkerTaskPackage): RuntimeCapability {
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

export function resolveRuntimeCapability(capability: RuntimeCapability): ResolvedRuntimeCapability {
  const configurationError = configurationErrorFor(capability);
  if (configurationError) return { kind: "configuration_error", capability, error: configurationError };
  const resolution = registeredAdapters.resolve({ capability: capability.capability, executionPath: capability.executionPath, provider: capability.provider, adapter: capability.adapter, model: capability.model, preset: capability.promptVersion });
  if (resolution.kind !== "registered") return { kind: "unregistered_execution", capability };
  if (resolution.choice.executionPath === "local") return { kind: "local_adapter", capability, registration: resolution.choice, readinessKey: resolution.choice.identityKey };
  return { kind: "registered_execution", capability };
}

export function createRuntimePreflight(capabilities: RuntimeCapability[], environment: RuntimePreflightEnvironment = {}): WorkerPreflightResult {
  const checks: WorkerPreflightResult["checks"] = [];
  for (const capability of capabilities) {
    const resolved = resolveRuntimeCapability(capability);
    if (resolved.kind === "configuration_error") {
      checks.push({ capability: capability.capability, check: "blueprint_configuration", phase: "preflight", status: "blocked", reason: resolved.error, action: "edit_blueprint", scope: "blueprint" });
      continue;
    }

    if (resolved.kind === "local_adapter") {
      if (environment.localAdapters && Object.prototype.hasOwnProperty.call(environment.localAdapters, resolved.readinessKey)) {
        checks.push({ ...dependencyCheck(capability.capability, "local_adapter_readiness", environment.localAdapters[resolved.readinessKey]), adapter: capability.adapter, provider: capability.provider });
      } else {
        checks.push({ adapter: capability.adapter, capability: capability.capability, check: "local_adapter_readiness", phase: "preflight", provider: capability.provider, status: "unavailable", reason: `本地 ${resolved.readinessKey} 尚未完成当前 Worker 就绪探测。`, action: "contact_environment_admin", scope: "worker" });
      }
      continue;
    }
    if (resolved.kind === "unregistered_execution") {
      checks.push({ capability: capability.capability, check: "capability_registration", phase: "preflight", status: "unavailable", reason: `当前 Worker 未注册 ${capability.provider}/${capability.adapter ?? "default"} 执行路径。`, action: "contact_environment_admin", scope: "worker" });
      continue;
    }
    checks.push({ capability: capability.capability, check: "capability_registration", phase: "preflight", status: "passed", reason: `Worker 已注册 ${capability.provider}${capability.adapter ? `/${capability.adapter}` : ""} 执行路径。`, action: "none", scope: "worker" });

    const allowedTools = stringArray(capability.allowedTools);
    const missingTools = requiredTools().filter((tool) => !allowedTools.includes(tool));
    if (missingTools.length) {
      checks.push({ capability: capability.capability, check: "tool_permission", phase: "preflight", status: "blocked", reason: `Worker 运行权限缺少 ${missingTools.join("、")}；请为当前 Worker 声明并授予对应文件能力。`, action: "contact_environment_admin", scope: "worker" });
    } else {
      checks.push({ capability: capability.capability, check: "tool_permission", phase: "preflight", status: "passed", reason: `Worker 运行权限包含 ${requiredTools().join(" 和 ")}。`, action: "none", scope: "worker" });
    }

    if (capability.credential && environment.credentials && Object.prototype.hasOwnProperty.call(environment.credentials, capability.credential)) {
      const credentialAvailable = environment.credentials[capability.credential];
      checks.push({ capability: capability.capability, check: "credential_presence", phase: "preflight", status: credentialAvailable ? "passed" : "unavailable", reason: credentialAvailable ? `${capability.credential} 已在 Worker 环境中配置。` : `${capability.credential} 未配置。`, action: credentialAvailable ? "none" : "contact_environment_admin", scope: "worker" });
    }

    if (capability.credentialRef && environment.connectionReferences && Object.prototype.hasOwnProperty.call(environment.connectionReferences, capability.credentialRef)) {
      checks.push(connectionReferenceCheck(capability.capability, environment.connectionReferences[capability.credentialRef]));
    }

    if (capability.credentialRef && environment.credentials && Object.prototype.hasOwnProperty.call(environment.credentials, capability.credentialRef)) {
      const available = environment.credentials[capability.credentialRef];
      checks.push({ capability: capability.capability, check: "credential_presence", phase: "preflight", status: available ? "passed" : "unavailable", reason: available ? "外部连接秘密已由 Worker 解析。" : "外部连接秘密不可用，请管理该连接。", action: available ? "none" : "manage_connection", scope: "connection" });
    }

    if (capability.command && environment.commands && Object.prototype.hasOwnProperty.call(environment.commands, capability.command)) {
      const commandStatus = environment.commands[capability.command];
      checks.push(dependencyCheck(capability.capability, "command_availability", commandStatus));
    }

    if (capability.model && environment.modelPermissions && Object.prototype.hasOwnProperty.call(environment.modelPermissions, capability.model)) {
      checks.push(capability.provider === "openai" && capability.adapter === "openai_images" ? openAiModelPermissionCheck(capability.capability, environment.modelPermissions[capability.model]) : dependencyCheck(capability.capability, "model_permission", environment.modelPermissions[capability.model]));
    }

    if (environment.connections && Object.prototype.hasOwnProperty.call(environment.connections, capability.provider)) {
      checks.push(dependencyCheck(capability.capability, "network_connectivity", environment.connections[capability.provider]));
    }

    if (capability.credential && environment.credentialValidity && Object.prototype.hasOwnProperty.call(environment.credentialValidity, capability.credential)) {
      checks.push(dependencyCheck(capability.capability, "credential_validity", environment.credentialValidity[capability.credential]));
    }
    if (capability.credentialRef && environment.credentialValidity && Object.prototype.hasOwnProperty.call(environment.credentialValidity, capability.credentialRef)) {
      checks.push(connectionCredentialValidityCheck(capability.capability, environment.credentialValidity[capability.credentialRef]));
    }
  }

  if (environment.assetRoot) {
    checks.push(dependencyCheck("worker_runtime", "asset_root", environment.assetRoot));
  }

  if (environment.mediaLibrary) {
    checks.push(dependencyCheck("worker_runtime", "media_library", environment.mediaLibrary));
  }

  return { version: workerPreflightVersion, checks };
}

export function credentialEnvironmentForProvider(provider: string): string | undefined {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "google_tts") return "GOOGLE_TTS_API_KEY";
  if (provider === "freesound") return "FREESOUND_API_KEY";
  return undefined;
}

export function credentialEnvironmentForReference(provider: string, _adapter: string | undefined, credentialRef: string | undefined): string | undefined {
  if (isConnectionId(credentialRef)) return undefined;
  if (_adapter) return undefined;
  return credentialEnvironmentForProvider(provider);
}

export function runtimeCommandForSelection(selection: { adapter?: string; capability: string; executionPath?: ExecutionPath | ""; provider?: string }): string | undefined {
  const resolution = registeredAdapters.resolve(selection);
  return resolution.kind === "registered" ? runtimeCommandForExecution(resolution.choice.execution.kind) : undefined;
}

export function runtimeCommandArguments(command: string): string[] {
  if (command === (process.env.WHISPERX_PYTHON?.trim() || "python3")) return ["-c", "import whisperx, torch; print('whisperx local runtime available')"];
  return command === "ffmpeg" ? ["-version"] : ["--version"];
}

export function runtimeCommandInvocation(command: string, argumentsList: string[], options: { openChatCutNode?: string } = {}): { command: string; argumentsList: string[] } {
  if (command === "openchatcut") return { command: options.openChatCutNode ?? process.env.OPENCHATCUT_NODE ?? process.execPath, argumentsList: ["scripts/openchatcut-render.mjs", ...argumentsList] };
  return { command, argumentsList };
}

export function localAdapterReadinessFromCommands(capabilities: readonly RuntimeCapability[], commands: Record<string, RuntimeDependencyStatus>): Record<string, RuntimeDependencyStatus> {
  return Object.fromEntries(capabilities.flatMap((capability) => {
    if (capability.executionPath !== "local" || !capability.adapter || !capability.command) return [];
    return [[`${capability.provider}:${capability.adapter}`, commands[capability.command] ?? { available: false, detail: `本地 ${capability.command} 尚未完成当前 Worker 就绪探测。` }] as const];
  }));
}

function capabilityFromExecutor(capability: string, executor: Record<string, unknown>, defaultProvider: string, requirements: { adapter?: boolean; promptHarness?: boolean } = {}): RuntimeCapability {
  const provider = stringValue(executor.provider) || defaultProvider;
  const adapter = stringValue(executor.adapter);
  const promptHarnessId = stringValue(executor.harness_id);
  return {
    capability,
    provider,
    ...(adapter ? { adapter } : {}),
    model: stringValue(executor.model),
    promptVersion: stringValue(executor.prompt_version),
    ...(promptHarnessId ? { promptHarnessId } : {}),
    ...(requirements.adapter ? { requiresAdapter: true } : {}),
    ...(requirements.promptHarness ? { requiresPromptHarness: true } : {}),
    allowedTools: requiredTools(),
    command: runtimeCommandForSelection({ capability, provider, adapter }),
  };
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredTools(): readonly string[] {
  return workerRequiredTools;
}

function isConnectionId(value: string | undefined): boolean {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
}

function runtimeCommandForExecution(kind: RegisteredAdapterChoice["execution"]["kind"]): string | undefined {
  if (kind === "codex") return "codex";
  if (kind === "ffmpeg") return "ffmpeg";
  if (kind === "openchatcut") return "openchatcut";
  if (kind === "whisperx") return process.env.WHISPERX_PYTHON?.trim() || "python3";
  return undefined;
}

function dependencyCheck(capability: string, check: string, dependency: RuntimeDependencyStatus): WorkerPreflightCheck {
  const status: WorkerPreflightStatus = dependency.available ? "passed" : dependency.status ?? "unavailable";
  return {
    capability,
    check,
    phase: "preflight" as const,
    status,
    reason: dependency.detail,
    action: dependency.available ? "none" as const : status === "retryable" ? "retry" as const : "contact_environment_admin" as const,
    scope: "worker" as const,
  };
}

function connectionReferenceCheck(capability: string, dependency: RuntimeDependencyStatus): WorkerPreflightCheck {
  const status: WorkerPreflightStatus = dependency.available ? "passed" : dependency.status ?? "unavailable";
  return {
    capability,
    check: "connection_reference",
    phase: "preflight",
    status,
    reason: dependency.detail,
    action: dependency.available ? "none" : status === "retryable" ? "retry" : "manage_connection",
    scope: "connection",
  };
}

function connectionCredentialValidityCheck(capability: string, dependency: RuntimeDependencyStatus): WorkerPreflightCheck {
  const status: WorkerPreflightStatus = dependency.available ? "passed" : dependency.status ?? "unavailable";
  return {
    capability,
    check: "credential_validity",
    phase: "preflight",
    status,
    reason: dependency.detail,
    action: dependency.available ? "none" : status === "retryable" ? "retry" : "manage_connection",
    scope: status === "retryable" ? "worker" : "connection",
  };
}

function openAiModelPermissionCheck(capability: string, dependency: RuntimeDependencyStatus): WorkerPreflightCheck {
  const status: WorkerPreflightStatus = dependency.available ? "passed" : dependency.status ?? "unavailable";
  return {
    capability,
    check: "model_permission",
    phase: "preflight",
    status,
    reason: dependency.detail,
    action: dependency.available ? "none" : status === "retryable" ? "retry" : "edit_blueprint",
    scope: dependency.available || status === "retryable" ? "worker" : "blueprint",
  };
}
