export const mediaCapabilityKeys = ["static_visual", "a_roll", "b_roll", "narration", "soundtrack"] as const;

export type MediaCapabilityKey = typeof mediaCapabilityKeys[number];
export type MediaCapabilityConfigurationField = "max_attempts";

export interface MediaCapability {
  capability: string;
  compactLabel: string;
  configurationFields: readonly MediaCapabilityConfigurationField[];
  defaultConfiguration: { model: string; promptVersion: string };
  description: string;
  label: string;
}

const mediaCapabilities: Record<MediaCapabilityKey, MediaCapability> = {
  static_visual: { capability: "static_visual_generation", compactLabel: "静态视觉", configurationFields: ["max_attempts"], defaultConfiguration: { model: "image-model-v1", promptVersion: "static-visual-v1" }, description: "生成或准备静态视觉资产。启用后需声明实际可用的图片生成 Adapter。", label: "静态视觉 / 图片生成" },
  a_roll: { capability: "a_roll_generation", compactLabel: "A-roll", configurationFields: ["max_attempts"], defaultConfiguration: { model: "video-generation-v1", promptVersion: "a-roll-v1" }, description: "生成需要实际出镜或演示的视频镜头，可选择本地 OpenChatCut 卡片视频 Adapter。", label: "A-roll" },
  b_roll: { capability: "b_roll_generation", compactLabel: "B-roll", configurationFields: ["max_attempts"], defaultConfiguration: { model: "pexels-video-v1", promptVersion: "b-roll-v1" }, description: "按分镜检索或生成补充画面，可使用外部 Pexels 或本地 OpenChatCut Adapter。", label: "B-roll" },
  narration: { capability: "narration_generation", compactLabel: "旁白", configurationFields: ["max_attempts"], defaultConfiguration: { model: "standard", promptVersion: "narration-v1" }, description: "根据本期 TTS 设置和分镜旁白文本生成叙述音频。", label: "旁白" },
  soundtrack: { capability: "soundtrack_generation", compactLabel: "配乐 / 音效", configurationFields: ["max_attempts"], defaultConfiguration: { model: "freesound-preview-v1", promptVersion: "soundtrack-v1" }, description: "根据分镜中的 BGM / SFX cue 检索配乐或音效，需要已配置的 Freesound 连接。", label: "配乐 / 音效" },
};

export function mediaCapabilityForKey(key: MediaCapabilityKey): MediaCapability {
  return mediaCapabilities[key];
}

export function mediaCapabilityForCapability(capability: string): MediaCapability | undefined {
  return mediaCapabilityKeys.map(mediaCapabilityForKey).find((candidate) => candidate.capability === capability);
}

export function mediaCapabilityKeyForCapability(capability: string): MediaCapabilityKey | undefined {
  return mediaCapabilityKeys.find((key) => mediaCapabilities[key].capability === capability);
}
