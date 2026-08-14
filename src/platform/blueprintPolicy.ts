import type { Json } from "../lib/database.types";
import { assetRootFromPolicy } from "../worker/assetRoot";

export const defaultBlueprintPolicy = {
  positioning: "",
  approval_gates: ["script", "visual", "storyboard", "qc", "publish"],
  asset_root: "",
  allowed_tools: ["read", "write"],
  budgets: { visual_planning_cents: 0 },
  executors: {
    visual_planning: {
      provider: "codex",
      model: "gpt-5.6-codex",
      prompt_version: "visual-planning-v1",
    },
  },
};

export function parseBlueprintPolicy(source: string): Json {
  const parsed: unknown = JSON.parse(source);

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("蓝图规则必须是 JSON 对象。");
  }

  return parsed as Json;
}

export function blueprintAssetRoot(policy: Json): string {
  return assetRootFromPolicy(policy);
}

export function withBlueprintAssetRoot(policy: Json, assetRoot: string): Json {
  if (!policy || Array.isArray(policy) || typeof policy !== "object") {
    throw new Error("蓝图规则必须是 JSON 对象。");
  }

  return { ...policy, asset_root: assetRoot.trim() };
}
