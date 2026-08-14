export function assetRootFromPolicy(policy: unknown): string {
  if (!policy || Array.isArray(policy) || typeof policy !== "object") return "";
  const assetRoot = (policy as Record<string, unknown>).asset_root;
  return typeof assetRoot === "string" ? assetRoot.trim() : "";
}
