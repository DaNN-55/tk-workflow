export const executionPathKeys = ["external", "local", "manual"] as const;

export type ExecutionPath = typeof executionPathKeys[number];
export type RegisteredExecutionPath = Exclude<ExecutionPath, "manual"> | "internal";
export type LocalAdapterReadiness = Readonly<Record<string, boolean>>;

export interface AcousticAlignmentCapabilities {
  nativeTimestamps: {
    support: "supported" | "unsupported";
    granularity?: "character" | "word" | "phrase";
    detail: string;
  };
  existingTextAudioAlignment: {
    support: "supported" | "unsupported";
    granularity?: "character" | "word" | "phrase";
    detail: string;
  };
}

export interface RegisteredAdapterCapability {
  capability: string;
  configurationFields: readonly string[];
  modelCatalog: readonly string[];
  presetCatalog: readonly string[];
  voiceCatalog?: Readonly<Record<string, readonly string[]>>;
  acousticAlignment?: AcousticAlignmentCapabilities;
}

export interface RegisteredAdapterChoice extends RegisteredAdapterCapability {
  adapter: string;
  connection: { kind: "none" } | { kind: "owner_managed"; type: string; endpoint?: string };
  execution: { kind: "codex" | "controlled_media" | "ffmpeg" | "openchatcut" | "whisperx"; safetyLimit: number };
  executionPath: RegisteredExecutionPath;
  identityKey: string;
  provider: string;
}

export type AdapterSelection = {
  adapter?: string;
  capability: string;
  executionPath?: ExecutionPath | "";
  model?: string;
  preset?: string;
  provider?: string;
};

export type AdapterResolution =
  | { kind: "manual"; capability: string }
  | { kind: "registered"; choice: RegisteredAdapterChoice }
  | { kind: "invalid"; code: "adapter_missing" | "adapter_unregistered" | "capability_unsupported" | "execution_path_mismatch" | "model_unsupported" | "preset_unsupported"; detail: string };

interface RegisteredAdapterDefinition {
  adapter: string;
  capabilities: readonly RegisteredAdapterCapability[];
  connection: RegisteredAdapterChoice["connection"];
  execution: RegisteredAdapterChoice["execution"];
  executionPath: RegisteredExecutionPath;
  provider: string;
}

const googleTtsAlignment: AcousticAlignmentCapabilities = {
  nativeTimestamps: { support: "unsupported", detail: "当前冻结的 Google TTS v1 synthesize 接口只返回音频；尚未迁移并验证 v1beta1 SSML_MARK。" },
  existingTextAudioAlignment: { support: "unsupported", detail: "当前 Google TTS Adapter 未注册已有文本与音频的强制打轴接口。" },
};

const volcengineTtsAlignment: AcousticAlignmentCapabilities = {
  nativeTimestamps: { support: "unsupported", detail: "当前豆包 V3 SSE 实现只请求并解析音频数据，尚未验证时间戳响应字段。" },
  existingTextAudioAlignment: { support: "unsupported", detail: "自动字幕打轴是独立服务与授权，当前冻结的豆包 TTS 连接版本未声明兼容。" },
};

const manifest: readonly RegisteredAdapterDefinition[] = [
  { provider: "codex", adapter: "codex", executionPath: "internal", connection: { kind: "none" }, execution: { kind: "codex", safetyLimit: 1 }, capabilities: [
    { capability: "script_writing", configurationFields: ["model"], modelCatalog: [], presetCatalog: [] },
    { capability: "visual_planning", configurationFields: ["model"], modelCatalog: [], presetCatalog: [] },
    { capability: "storyboard_planning", configurationFields: ["model", "prompt_harness"], modelCatalog: [], presetCatalog: [] },
  ] },
  { provider: "openai", adapter: "openai_images", executionPath: "external", connection: { kind: "owner_managed", type: "openai_api" }, execution: { kind: "controlled_media", safetyLimit: 1 }, capabilities: [
    { capability: "static_visual_generation", configurationFields: ["model", "credential_ref", "max_attempts"], modelCatalog: ["gpt-image-1"], presetCatalog: ["static-visual-v1"] },
  ] },
  { provider: "cloudflare", adapter: "workers_ai_images", executionPath: "external", connection: { kind: "owner_managed", type: "cloudflare_workers_ai_api", endpoint: "https://api.cloudflare.com/client/v4" }, execution: { kind: "controlled_media", safetyLimit: 1 }, capabilities: [
    { capability: "static_visual_generation", configurationFields: ["model", "credential_ref", "max_attempts"], modelCatalog: ["@cf/black-forest-labs/flux-1-schnell"], presetCatalog: ["static-visual-v1"] },
  ] },
  { provider: "pexels", adapter: "pexels_video", executionPath: "external", connection: { kind: "owner_managed", type: "pexels_api" }, execution: { kind: "controlled_media", safetyLimit: 3 }, capabilities: [
    { capability: "b_roll_generation", configurationFields: ["max_attempts"], modelCatalog: ["pexels-video-v1"], presetCatalog: ["b-roll-v1"] },
  ] },
  { provider: "google_tts", adapter: "google_tts", executionPath: "external", connection: { kind: "owner_managed", type: "google_tts_api", endpoint: "https://texttospeech.googleapis.com/v1" }, execution: { kind: "controlled_media", safetyLimit: 2 }, capabilities: [
    { capability: "narration_generation", configurationFields: ["credential_ref", "max_attempts"], modelCatalog: ["standard"], presetCatalog: ["narration-v1"], voiceCatalog: { "en-US": ["en-US-Standard-A", "en-US-Standard-B", "en-US-Standard-C", "en-US-Standard-D"], "zh-CN": ["cmn-CN-Standard-A", "cmn-CN-Standard-B", "cmn-CN-Standard-C", "cmn-CN-Standard-D", "cmn-CN-standard-cm"], "vi-VN": ["vi-VN-Standard-A", "vi-VN-Standard-B", "vi-VN-Standard-C", "vi-VN-Standard-D"] }, acousticAlignment: googleTtsAlignment },
  ] },
  { provider: "volcengine_tts", adapter: "volcengine_tts", executionPath: "external", connection: { kind: "owner_managed", type: "volcengine_tts_api", endpoint: "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse" }, execution: { kind: "controlled_media", safetyLimit: 2 }, capabilities: [
    { capability: "narration_generation", configurationFields: ["credential_ref", "max_attempts"], modelCatalog: ["seed-tts-2.0"], presetCatalog: ["narration-v1"], voiceCatalog: { "zh-CN": ["zh_female_vv_uranus_bigtts", "zh_male_m191_uranus_bigtts", "zh_male_taocheng_uranus_bigtts", "zh_female_xiaohe_uranus_bigtts", "zh_female_qingxinnvsheng_uranus_bigtts", "zh_male_huolixiaoge_uranus_bigtts", "zh_male_baqiqingshu_uranus_bigtts", "zh_female_mizai_uranus_bigtts", "ICL_uranus_zh_male_paoxiaoxiaoge_tob", "zh_male_xionger_uranus_bigtts"], "en-US": ["zh_female_vv_uranus_bigtts"], "ja-JP": ["zh_female_vv_uranus_bigtts"], "es-ES": ["zh_female_vv_uranus_bigtts"] }, acousticAlignment: volcengineTtsAlignment },
  ] },
  { provider: "freesound", adapter: "freesound_preview", executionPath: "external", connection: { kind: "owner_managed", type: "freesound_api", endpoint: "https://freesound.org/apiv2" }, execution: { kind: "controlled_media", safetyLimit: 1 }, capabilities: [
    { capability: "soundtrack_generation", configurationFields: ["credential_ref", "max_attempts"], modelCatalog: ["freesound-preview-v1"], presetCatalog: ["soundtrack-v1"] },
  ] },
  { provider: "ffmpeg", adapter: "ffmpeg_extract_audio", executionPath: "internal", connection: { kind: "none" }, execution: { kind: "ffmpeg", safetyLimit: 1 }, capabilities: [
    { capability: "embedded_audio_extraction", configurationFields: [], modelCatalog: [], presetCatalog: [] },
  ] },
  { provider: "ffmpeg", adapter: "ffmpeg_trim_video", executionPath: "internal", connection: { kind: "none" }, execution: { kind: "ffmpeg", safetyLimit: 1 }, capabilities: [
    { capability: "shot_clip_preparation", configurationFields: [], modelCatalog: [], presetCatalog: [] },
  ] },
  { provider: "whisperx", adapter: "whisperx_local", executionPath: "local", connection: { kind: "none" }, execution: { kind: "whisperx", safetyLimit: 1 }, capabilities: [
    { capability: "acoustic_alignment", configurationFields: [], modelCatalog: ["large-v3"], presetCatalog: ["whisperx-alignment-v1"] },
  ] },
  { provider: "openchatcut", adapter: "openchatcut_card_video", executionPath: "local", connection: { kind: "none" }, execution: { kind: "openchatcut", safetyLimit: 1 }, capabilities: [
    { capability: "a_roll_generation", configurationFields: ["max_attempts"], modelCatalog: ["openchatcut@0.2.14"], presetCatalog: ["card-video-v1"] },
    { capability: "b_roll_generation", configurationFields: ["max_attempts"], modelCatalog: ["openchatcut@0.2.14"], presetCatalog: ["card-video-v1"] },
  ] },
  { provider: "openchatcut", adapter: "openchatcut", executionPath: "internal", connection: { kind: "none" }, execution: { kind: "openchatcut", safetyLimit: 1 }, capabilities: [
    { capability: "review_rendering", configurationFields: [], modelCatalog: ["openchatcut@0.2.14"], presetCatalog: ["review-render-v1"] },
    { capability: "final_rendering", configurationFields: [], modelCatalog: ["openchatcut@0.2.14"], presetCatalog: ["final-render-v1"] },
  ] },
] as const;

function identityKey(provider: string, adapter: string): string {
  return `${provider}:${adapter}`;
}

function validateManifest(definitions: readonly RegisteredAdapterDefinition[]): void {
  const identities = new Set<string>();
  for (const definition of definitions) {
    const identity = identityKey(definition.provider, definition.adapter);
    if (!definition.provider || !definition.adapter || definition.capabilities.length === 0) throw new Error("Adapter manifest 存在空身份或空能力声明。");
    if (identities.has(identity)) throw new Error(`重复的 Adapter 身份：${identity}`);
    if (!Number.isInteger(definition.execution.safetyLimit) || definition.execution.safetyLimit < 1) throw new Error(`Adapter ${identity} 的安全并发上限无效。`);
    if ((definition.executionPath === "external") !== (definition.connection.kind === "owner_managed")) throw new Error(`Adapter ${identity} 的执行路径与连接要求不一致。`);
    const capabilities = new Set<string>();
    for (const declaration of definition.capabilities) {
      if (capabilities.has(declaration.capability)) throw new Error(`Adapter ${identity} 重复声明能力 ${declaration.capability}。`);
      capabilities.add(declaration.capability);
    }
    identities.add(identity);
  }
}

validateManifest(manifest);

function choicesFor({ capability, executionPath }: { capability: string; executionPath?: RegisteredExecutionPath }): readonly RegisteredAdapterChoice[] {
  return manifest.flatMap((definition) => {
    if (executionPath && definition.executionPath !== executionPath) return [];
    const declaration = definition.capabilities.find((candidate) => candidate.capability === capability);
    return declaration ? [{ ...declaration, adapter: definition.adapter, connection: definition.connection, execution: definition.execution, executionPath: definition.executionPath, identityKey: identityKey(definition.provider, definition.adapter), provider: definition.provider }] : [];
  });
}

function resolve(selection: AdapterSelection): AdapterResolution {
  if (selection.executionPath === "manual") return { kind: "manual", capability: selection.capability };
  const provider = selection.provider?.trim() ?? "";
  let adapter = selection.adapter?.trim() ?? "";
  if (!adapter && provider === "openchatcut" && (selection.capability === "review_rendering" || selection.capability === "final_rendering")) adapter = "openchatcut";
  if (!provider || !adapter) return { kind: "invalid", code: "adapter_missing", detail: `能力 ${selection.capability} 缺少 Provider 或 Adapter。` };
  const definition = manifest.find((candidate) => candidate.provider === provider && candidate.adapter === adapter);
  if (!definition) return { kind: "invalid", code: "adapter_unregistered", detail: `未注册 Adapter ${provider}/${adapter}。` };
  const declaration = definition.capabilities.find((candidate) => candidate.capability === selection.capability);
  if (!declaration) return { kind: "invalid", code: "capability_unsupported", detail: `Adapter ${provider}/${adapter} 不支持能力 ${selection.capability}。` };
  if (selection.executionPath && selection.executionPath !== definition.executionPath) return { kind: "invalid", code: "execution_path_mismatch", detail: `Adapter ${provider}/${adapter} 不属于 ${selection.executionPath} 执行路径。` };
  if (selection.model && declaration.modelCatalog.length && !declaration.modelCatalog.includes(selection.model)) return { kind: "invalid", code: "model_unsupported", detail: `Adapter ${provider}/${adapter} 不支持模型 ${selection.model}。` };
  if (selection.preset && declaration.presetCatalog.length && !declaration.presetCatalog.includes(selection.preset)) return { kind: "invalid", code: "preset_unsupported", detail: `Adapter ${provider}/${adapter} 不支持预设 ${selection.preset}。` };
  return { kind: "registered", choice: { ...declaration, adapter, connection: definition.connection, execution: definition.execution, executionPath: definition.executionPath, identityKey: identityKey(provider, adapter), provider } };
}

export const registeredAdapters = Object.freeze({ choicesFor, resolve });
