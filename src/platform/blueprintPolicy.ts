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
