import type { Json } from "../lib/database.types";
import { mediaCapabilityForKey, mediaCapabilityKeys, type MediaCapabilityKey } from "../worker/productionCapabilities";
import { executionPathKeys, registeredAdapters, type ExecutionPath } from "../worker/registeredAdapters";

type JsonObject = Record<string, Json | undefined>;
type ExecutorForm = { provider: string; adapter?: string; harnessId?: string; model: string; promptVersion: string };

export const mediaAdapterKeys = mediaCapabilityKeys;
export type MediaAdapterKey = MediaCapabilityKey;
export const configurableMediaAdapterKeys = mediaAdapterKeys;
export type ConfigurableMediaAdapterKey = typeof configurableMediaAdapterKeys[number];
export type MediaAdapterForm = {
  executionPath?: ExecutionPath | "";
  provider: string;
  adapter: string;
  credentialRef: string;
  model: string;
  promptVersion: string;
  allowedTools: string;
  budgetCents: string;
  perShotBudgetCents: string;
  totalBudgetCents: string;
  maxAttempts: string;
  maxConcurrency: string;
  providerMaxConcurrency: string;
  voiceLanguageCode: string;
  voiceName: string;
  voiceSpeakingRate: string;
};

export interface BlueprintFormValues {
  positioning: string;
  assetRoot: string;
  approvalGates: string[];
  allowedTools: string[];
  enabledMediaAdapters?: ConfigurableMediaAdapterKey[];
  budgets: { scriptWritingCents: string; visualPlanningCents: string; storyboardPlanningCents: string };
  executors: Record<"script_writing" | "visual_planning" | "storyboard_planning", ExecutorForm>;
  mediaAdapters: Record<MediaAdapterKey, MediaAdapterForm>;
  advancedJson: string;
}

export interface SeriesFormValues {
  positioning: string;
  format: string;
  characters: string;
  locations: string;
  visualStyle: string;
  narrativeStructure: string;
  restrictions: string;
}

const blueprintKnownKeys = new Set(["positioning", "asset_root", "approval_gates", "allowed_tools", "budgets", "executors", ...mediaAdapterKeys]);
const seriesKnownKeys = new Set(["positioning", "format", "characters", "locations", "visual_style", "narrative_structure", "restrictions"]);
const executorKeys = ["script_writing", "storyboard_planning"] as const;
const visibleToolKeys = new Set(["read", "write"]);
export function mediaAdapterConfiguration(key: MediaAdapterKey) {
  return mediaCapabilityForKey(key);
}

function objectValue(value: Json | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

function displayValue(value: Json | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function stringArray(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function blueprintAdvancedJson(value: JsonObject): string {
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !blueprintKnownKeys.has(key)));
  const executors = objectValue(value.executors);
  const executorExtra: JsonObject = {};
  for (const [key, rawExecutor] of Object.entries(executors)) {
    const executor = objectValue(rawExecutor);
    const fields = Object.fromEntries(Object.entries(executor).filter(([field]) => !new Set(["provider", "adapter", "harness_id", "model", "prompt_version"]).has(field)));
    if (Object.keys(fields).length) executorExtra[key] = fields;
  }
  if (Object.keys(executorExtra).length) extra.executors = executorExtra;
  for (const key of mediaAdapterKeys) {
    const mediaAdapter = objectValue(value[key]);
    const mediaAdapterExtra: JsonObject = {};
    for (const [field, rawValue] of Object.entries(mediaAdapter)) {
      if (field !== "executor" && field !== "credential_ref" && field !== "allowed_tools" && field !== "budget_cents" && field !== "per_shot_budget_cents" && field !== "total_budget_cents" && field !== "max_attempts" && field !== "max_concurrency" && field !== "provider_max_concurrency" && field !== "voice") mediaAdapterExtra[field] = rawValue;
    }
    const mediaExecutor = objectValue(mediaAdapter.executor);
    const mediaExecutorExtra = Object.fromEntries(Object.entries(mediaExecutor).filter(([field]) => !new Set(["provider", "adapter", "model", "prompt_version"]).has(field)));
    if (Object.keys(mediaExecutorExtra).length) mediaAdapterExtra.executor = mediaExecutorExtra;
    if (Object.keys(mediaAdapterExtra).length) extra[key] = mediaAdapterExtra;
  }
  return JSON.stringify(extra, null, 2);
}

function parseAdvancedJson(source: string): JsonObject {
  if (!source.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("高级规则必须是有效的 JSON 对象。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("高级规则必须是 JSON 对象。");
  return parsed as JsonObject;
}

function formExecutor(value: Json | undefined): ExecutorForm {
  const executor = objectValue(value);
  return { provider: stringValue(executor.provider) || "codex", adapter: stringValue(executor.adapter) || "codex", harnessId: stringValue(executor.harness_id), model: stringValue(executor.model) || "gpt-5.6-codex", promptVersion: stringValue(executor.prompt_version) || "unversioned" };
}

function formMediaAdapter(_key: MediaAdapterKey, value: Json | undefined, fallbackAllowedTools: readonly string[] = []): MediaAdapterForm {
  const mediaAdapter = objectValue(value);
  const executor = objectValue(mediaAdapter.executor);
  const allowedTools = stringArray(mediaAdapter.allowed_tools);
  const visibleAllowedTools = allowedTools.filter((tool) => visibleToolKeys.has(tool));
  const configuredPath = stringValue(mediaAdapter.execution_path);
  const executionPath = executionPathKeys.includes(configuredPath as ExecutionPath) ? configuredPath as ExecutionPath : "";
  const resolved = registeredAdapters.resolve({ capability: mediaCapabilityForKey(_key).capability, executionPath, provider: stringValue(executor.provider), adapter: stringValue(executor.adapter) });
  const effectiveAllowedTools = resolved.kind === "registered" && fallbackAllowedTools.length ? fallbackAllowedTools : visibleAllowedTools;
  return {
    ...(executionPath ? { executionPath } : {}),
    provider: stringValue(executor.provider),
    adapter: stringValue(executor.adapter),
    credentialRef: stringValue(mediaAdapter.credential_ref),
    model: stringValue(executor.model),
    promptVersion: stringValue(executor.prompt_version),
    allowedTools: effectiveAllowedTools.join(", "),
    budgetCents: displayValue(mediaAdapter.budget_cents),
    perShotBudgetCents: displayValue(mediaAdapter.per_shot_budget_cents),
    totalBudgetCents: displayValue(mediaAdapter.total_budget_cents),
    maxAttempts: displayValue(mediaAdapter.max_attempts),
    maxConcurrency: displayValue(mediaAdapter.max_concurrency),
    providerMaxConcurrency: displayValue(mediaAdapter.provider_max_concurrency),
    voiceLanguageCode: "",
    voiceName: "",
    voiceSpeakingRate: "",
  };
}

export function defaultMediaAdapterForm(_key: ConfigurableMediaAdapterKey): MediaAdapterForm {
  return { provider: "", adapter: "", credentialRef: "", model: "", promptVersion: "", allowedTools: "", budgetCents: "", perShotBudgetCents: "", totalBudgetCents: "", maxAttempts: "", maxConcurrency: "", providerMaxConcurrency: "", voiceLanguageCode: "", voiceName: "", voiceSpeakingRate: "" };
}

function mediaAdapterHasValues(form: MediaAdapterForm): boolean {
  return Object.values(form).some((value) => value.trim() !== "");
}

function positiveInteger(source: string, label: string): number {
  const value = Number(source);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}必须是大于 0 的整数。`);
  return value;
}

export function validateMediaAdapter(key: MediaAdapterKey, form: MediaAdapterForm, options: { availableExternalConnectionVersionIds?: readonly string[] } = {}): void {
  if (!mediaAdapterHasValues(form)) return;
  const definition = mediaAdapterConfiguration(key);
  const { configurationFields, label } = definition;
  if (!form.executionPath) throw new Error(`${label}适配器必须先选择执行路径。`);
  if (form.executionPath === "manual") return;
  if (!form.provider.trim() || !form.adapter.trim() || !form.model.trim() || !form.promptVersion.trim()) throw new Error(`${label}适配器的 Provider、Adapter、模型和 Prompt 版本不能为空。`);
  validateRegisteredMediaConnection(label, key, form, options);
  if (configurationFields.includes("max_attempts")) positiveInteger(form.maxAttempts, `${label}最大尝试次数`);
}

function validateRegisteredMediaConnection(label: string, key: MediaAdapterKey, form: MediaAdapterForm, options: { availableExternalConnectionVersionIds?: readonly string[] }): void {
  const resolved = registeredAdapters.resolve({ capability: mediaCapabilityForKey(key).capability, executionPath: form.executionPath, provider: form.provider.trim(), adapter: form.adapter.trim(), model: form.model.trim(), preset: form.promptVersion.trim() });
  if (resolved.kind !== "registered") throw new Error(`${label}${resolved.kind === "invalid" ? resolved.detail : "必须选择已注册的 Adapter。"}`);
  const registration = resolved.choice;
  if (form.executionPath === "local") return;
  const credentialRef = form.credentialRef.trim();
  const dynamicConnection = registration.connection.kind === "owner_managed" && isUuid(credentialRef);
  if (dynamicConnection && options.availableExternalConnectionVersionIds && !options.availableExternalConnectionVersionIds.includes(credentialRef)) throw new Error(`${label}必须选择当前且已验证的外部连接版本。`);
  if (registration.connection.kind === "owner_managed" && !dynamicConnection) throw new Error(`${label}必须选择可用的外部连接。`);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function validateMediaAdapters(mediaAdapters: Record<MediaAdapterKey, MediaAdapterForm>, options: { availableExternalConnectionVersionIds?: readonly string[]; enabledKeys?: readonly MediaAdapterKey[] } = {}): void {
  for (const key of options.enabledKeys ?? mediaAdapterKeys) validateMediaAdapter(key, mediaAdapters[key], options);
}

export function mediaAdapterStatus(key: MediaAdapterKey, form: MediaAdapterForm, options: { availableExternalConnectionVersionIds?: readonly string[] } = {}): "未配置" | "待补齐" | "已配置" {
  if (!mediaAdapterHasValues(form)) return "未配置";
  try {
    validateMediaAdapter(key, form, options);
    return "已配置";
  } catch {
    return "待补齐";
  }
}

function mediaAdapterToPolicy(_key: MediaAdapterKey, form: MediaAdapterForm, existing: JsonObject): JsonObject {
  const policy: JsonObject = { ...existing };
  policy.execution_path = form.executionPath;
  if (form.executionPath === "manual") {
    delete policy.executor;
    delete policy.credential_ref;
    delete policy.voice;
    delete policy.max_attempts;
    delete policy.max_concurrency;
    delete policy.provider_max_concurrency;
    delete policy.budget_cents;
    delete policy.per_shot_budget_cents;
    delete policy.total_budget_cents;
    return policy;
  }
  const executorValues: Array<["provider" | "adapter" | "model" | "promptVersion", string]> = [["provider", "provider"], ["adapter", "adapter"], ["model", "model"], ["promptVersion", "prompt_version"]];
  if (executorValues.some(([formKey]) => form[formKey].trim())) {
    const executor = objectValue(existing.executor);
    for (const [formKey, policyKey] of executorValues) if (form[formKey].trim()) executor[policyKey] = form[formKey].trim();
    policy.executor = executor;
  }
  delete policy.allowed_tools;
  if (form.credentialRef.trim()) policy.credential_ref = form.credentialRef.trim();
  else delete policy.credential_ref;
  delete policy.budget_cents;
  delete policy.per_shot_budget_cents;
  delete policy.total_budget_cents;
  delete policy.max_concurrency;
  delete policy.provider_max_concurrency;
  if (form.maxAttempts.trim()) policy.max_attempts = Number(form.maxAttempts);
  else delete policy.max_attempts;
  delete policy.voice;
  return policy;
}

export function blueprintPolicyToForm(policy: Json): BlueprintFormValues {
  const value = objectValue(policy);
  const executors = objectValue(value.executors);
  const accountAllowedTools = stringArray(value.allowed_tools).filter((tool) => visibleToolKeys.has(tool));
  const fallbackMediaAdapterTools = accountAllowedTools.length ? accountAllowedTools : ["read", "write"];
  const enabledMediaAdapters = configurableMediaAdapterKeys.filter((key) => value[key] !== undefined && value[key] !== null);
  return {
    positioning: stringValue(value.positioning),
    assetRoot: stringValue(value.asset_root),
    approvalGates: Array.isArray(value.approval_gates) ? stringArray(value.approval_gates).filter((gate) => gate !== "publish") : ["script", "visual", "storyboard", "qc"],
    allowedTools: fallbackMediaAdapterTools,
    enabledMediaAdapters,
    budgets: { scriptWritingCents: "0", visualPlanningCents: "0", storyboardPlanningCents: "0" },
    executors: {
      script_writing: formExecutor(executors.script_writing),
      visual_planning: formExecutor(executors.visual_planning),
      storyboard_planning: formExecutor(executors.storyboard_planning),
    },
    mediaAdapters: {
      static_visual: formMediaAdapter("static_visual", value.static_visual, fallbackMediaAdapterTools),
      a_roll: formMediaAdapter("a_roll", value.a_roll, fallbackMediaAdapterTools),
      b_roll: formMediaAdapter("b_roll", value.b_roll, fallbackMediaAdapterTools),
      narration: formMediaAdapter("narration", value.narration, fallbackMediaAdapterTools),
      soundtrack: formMediaAdapter("soundtrack", value.soundtrack, fallbackMediaAdapterTools),
    },
    advancedJson: blueprintAdvancedJson(value),
  };
}

export function blueprintFormToPolicy(form: BlueprintFormValues): Json {
  const advanced = parseAdvancedJson(form.advancedJson);
  const existingExecutors = objectValue(advanced.executors);
  const existingMediaAdapters = Object.fromEntries(mediaAdapterKeys.map((key) => [key, objectValue(advanced[key])])) as Record<MediaAdapterKey, JsonObject>;
  delete advanced.budgets;
  delete advanced.executors;
  for (const key of mediaAdapterKeys) delete advanced[key];
  const result: JsonObject = {
    ...advanced,
    positioning: form.positioning.trim(),
    asset_root: form.assetRoot.trim(),
    approval_gates: form.approvalGates,
    budgets: { script_writing_cents: 0, storyboard_planning_cents: 0 },
    executors: {
      ...existingExecutors,
      ...Object.fromEntries(executorKeys.map((key) => {
        const executor = form.executors[key];
        const adapter = executor.adapter?.trim();
        const harnessId = executor.harnessId?.trim();
        return [key, {
          ...objectValue(existingExecutors[key]),
          provider: executor.provider.trim(),
          ...(adapter ? { adapter } : {}),
          model: executor.model.trim(),
          prompt_version: executor.promptVersion.trim(),
          ...(harnessId ? { harness_id: harnessId } : {}),
        }];
      })),
    },
  };
  const enabledMediaAdapters = form.enabledMediaAdapters ?? configurableMediaAdapterKeys;
  for (const key of mediaAdapterKeys) {
    if (!enabledMediaAdapters.includes(key)) continue;
    const mediaAdapter = form.mediaAdapters[key] ?? defaultMediaAdapterForm(key);
    const hasFormValues = mediaAdapterHasValues(mediaAdapter);
    result[key] = hasFormValues ? mediaAdapterToPolicy(key, mediaAdapter, existingMediaAdapters[key]) : existingMediaAdapters[key];
  }
  return result as Json;
}

export function seriesRulesToForm(rules: Json): SeriesFormValues {
  const value = objectValue(rules);
  return {
    positioning: displayValue(value.positioning),
    format: displayValue(value.format),
    characters: displayValue(value.characters),
    locations: displayValue(value.locations),
    visualStyle: displayValue(value.visual_style),
    narrativeStructure: displayValue(value.narrative_structure),
    restrictions: displayValue(value.restrictions),
  };
}

export function seriesFormToRules(form: SeriesFormValues): Json {
  return Object.fromEntries([
    ["positioning", parseSeriesField(form.positioning)],
    ["format", parseSeriesField(form.format)],
    ["characters", parseSeriesField(form.characters)],
    ["locations", parseSeriesField(form.locations)],
    ["visual_style", parseSeriesField(form.visualStyle)],
    ["narrative_structure", parseSeriesField(form.narrativeStructure)],
    ["restrictions", parseSeriesField(form.restrictions)],
  ].filter(([, value]) => value !== undefined)) as Json;
}

function parseSeriesField(source: string): Json | undefined {
  const value = source.trim();
  if (!value) return undefined;
  if (value.startsWith("{") || value.startsWith("[")) {
    try { return JSON.parse(value) as Json; } catch { return value; }
  }
  return value;
}

export function validateSeriesRules(rules: Json): void {
  const value = objectValue(rules);
  const unsupported = Object.keys(value).filter((key) => !seriesKnownKeys.has(key));
  if (unsupported.length) throw new Error(`系列规则仅支持表单字段：${unsupported.join("、")}。`);
}
