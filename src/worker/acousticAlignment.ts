import { createHash } from "node:crypto";
import type { AcousticAlignmentCapabilities } from "./registeredAdapters.js";
import type { AcousticAlignmentCandidate, AcousticAlignmentResult } from "./acousticAlignmentContract.js";

export { acousticAlignmentGranularities, acousticAlignmentMethods, acousticAlignmentStatuses, isValidAcousticAlignmentResult } from "./acousticAlignmentContract.js";
export type { AcousticAlignmentCandidate, AcousticAlignmentCue, AcousticAlignmentGranularity, AcousticAlignmentMethod, AcousticAlignmentResult, AcousticAlignmentStatus } from "./acousticAlignmentContract.js";

export interface AcousticAlignmentInput {
  audioSha256: string;
  capabilities: AcousticAlignmentCapabilities;
  confirmedText: string;
  connectionVersionId?: string;
  model: string;
  nativeCandidate?: AcousticAlignmentCandidate;
  provider: string;
  speakingRate: number;
  voice: string;
  alignExistingTextAudio?: () => Promise<AcousticAlignmentCandidate>;
  alignLocalWhisperX?: () => Promise<AcousticAlignmentResult>;
  now?: () => Date;
}

export async function runAcousticAlignmentPriorityChain(input: AcousticAlignmentInput): Promise<AcousticAlignmentResult> {
  const base = alignmentIdentity(input);
  const attempts: AcousticAlignmentResult["attempts"] = [];
  if (input.capabilities.nativeTimestamps.support === "supported") {
    if (input.nativeCandidate) {
      const completed = completedResult(input, input.nativeCandidate, attempts, base);
      if (completed) return completed;
      attempts.push({ method: "tts_native", status: "failed", detail: "原生时间戳未能逐项映射 Owner 已确认字幕，已拒绝采用。" });
    } else {
      attempts.push({ method: "tts_native", status: "failed", detail: "同次 TTS 响应没有返回 Adapter 声明的原生时间戳。" });
    }
  } else {
    attempts.push({ method: "tts_native", status: "unsupported", detail: input.capabilities.nativeTimestamps.detail });
  }

  if (input.capabilities.existingTextAudioAlignment.support === "supported" && input.alignExistingTextAudio) {
    try {
      const candidate = await input.alignExistingTextAudio();
      const completed = completedResult(input, candidate, attempts, base);
      if (completed) return completed;
      attempts.push({ method: "external_text_audio", status: "failed", detail: "外部打轴文本与 Owner 已确认字幕不一致，已拒绝采用。" });
    } catch (error) {
      attempts.push({ method: "external_text_audio", status: "failed", detail: error instanceof Error ? error.message : "外部字幕打轴失败。" });
    }
  } else {
    attempts.push({ method: "external_text_audio", status: "unsupported", detail: input.capabilities.existingTextAudioAlignment.detail });
  }

  if (input.alignLocalWhisperX) {
    try {
      const local = await input.alignLocalWhisperX();
      if (local.audioSha256 !== base.audioSha256 || local.textFingerprint !== base.textFingerprint || local.inputVersion !== base.inputVersion) throw new Error("本地 WhisperX 结果与冻结输入版本不一致。");
      return { ...local, attempts: [...attempts, ...local.attempts] };
    } catch (error) {
      attempts.push({ method: "local_whisperx", status: "failed", detail: error instanceof Error ? error.message : "本地 WhisperX 对齐失败。" });
    }
  } else {
    attempts.push({ method: "local_whisperx", status: "unsupported", detail: "当前 Worker 未配置本地 WhisperX runner。" });
  }

  return {
    version: "acoustic-alignment/v1",
    status: "failed",
    method: "none",
    granularity: "none",
    ...base,
    provider: input.provider,
    model: input.model,
    connectionVersionId: input.connectionVersionId ?? null,
    wordCount: 0,
    cues: [],
    reviewIssues: [],
    attempts,
    detail: attempts.at(-1)?.detail ?? "没有可用的声学对齐能力。",
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

function completedResult(
  input: AcousticAlignmentInput,
  candidate: AcousticAlignmentCandidate,
  attempts: AcousticAlignmentResult["attempts"],
  base: Pick<AcousticAlignmentResult, "audioSha256" | "textFingerprint" | "inputVersion">,
): AcousticAlignmentResult | null {
  if (!validCandidate(candidate, input.confirmedText)) return null;
  return {
    version: "acoustic-alignment/v1",
    status: "completed",
    method: candidate.method,
    granularity: candidate.granularity,
    ...base,
    provider: candidate.provider,
    model: candidate.model,
    connectionVersionId: input.connectionVersionId ?? null,
    wordCount: candidate.cues.length,
    cues: candidate.cues,
    reviewIssues: [],
    attempts: [...attempts, { method: candidate.method, status: "completed", detail: candidate.method === "tts_native" ? "已优先采用同次 TTS 原生时间戳。" : "已采用已有文本与音频的外部字幕打轴。" }],
    detail: candidate.method === "tts_native" ? "同次 TTS 原生时间戳已完成。" : "外部字幕打轴已完成。",
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

export function alignmentIdentity(input: Pick<AcousticAlignmentInput, "audioSha256" | "confirmedText" | "voice" | "speakingRate" | "provider" | "model" | "connectionVersionId">): Pick<AcousticAlignmentResult, "audioSha256" | "textFingerprint" | "inputVersion"> {
  const textFingerprint = createHash("sha256").update(input.confirmedText).digest("hex");
  const inputVersion = createHash("sha256").update(JSON.stringify({
    audioSha256: input.audioSha256,
    textFingerprint,
    voice: input.voice,
    speakingRate: input.speakingRate,
    provider: input.provider,
    model: input.model,
    connectionVersionId: input.connectionVersionId ?? null,
  })).digest("hex");
  return { audioSha256: input.audioSha256, textFingerprint, inputVersion };
}

function validCandidate(candidate: AcousticAlignmentCandidate, confirmedText: string): boolean {
  if (!candidate.cues.length || candidate.cues.some((cue) => !cue.id || !cue.text || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs)) return false;
  for (let index = 1; index < candidate.cues.length; index += 1) if (candidate.cues[index].startMs < candidate.cues[index - 1].startMs) return false;
  const reportedText = candidate.reportedText ?? candidate.cues.map((cue) => cue.text).join("");
  return comparableText(reportedText) === comparableText(confirmedText);
}

function comparableText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}
