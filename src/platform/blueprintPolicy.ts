import type { Json } from "../lib/database.types";

export const defaultBlueprintPolicy = {
  positioning: "",
  approval_gates: ["script", "visual", "storyboard", "qc", "publish"],
  asset_root: "",
};

export function parseBlueprintPolicy(source: string): Json {
  const parsed: unknown = JSON.parse(source);

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("蓝图规则必须是 JSON 对象。");
  }

  return parsed as Json;
}

export function blueprintAssetRoot(policy: Json): string {
  if (!policy || Array.isArray(policy) || typeof policy !== "object") return "";
  return typeof policy.asset_root === "string" ? policy.asset_root : "";
}

export function withBlueprintAssetRoot(policy: Json, assetRoot: string): Json {
  if (!policy || Array.isArray(policy) || typeof policy !== "object") {
    throw new Error("蓝图规则必须是 JSON 对象。");
  }

  return { ...policy, asset_root: assetRoot.trim() };
}
