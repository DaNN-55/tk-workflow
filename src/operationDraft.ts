const storagePrefix = "loop-control.operation-draft.v1";

export type OperationDraftKind = "publication-confirmation" | "review-decision";

function storageKey(ownerId: string, episodeId: string, kind: OperationDraftKind) {
  return `${storagePrefix}:${ownerId}:${episodeId}:${kind}`;
}

export function readOperationDraft<T extends object>(ownerId: string, episodeId: string, kind: OperationDraftKind): T | null {
  try {
    const value = localStorage.getItem(storageKey(ownerId, episodeId, kind));
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

export function writeOperationDraft(ownerId: string, episodeId: string, kind: OperationDraftKind, value: object) {
  try {
    localStorage.setItem(storageKey(ownerId, episodeId, kind), JSON.stringify(value));
  } catch {
    // 浏览器禁用本地存储时，填写内容仍在当前打开的抽屉中保留。
  }
}

export function clearOperationDraft(ownerId: string, episodeId: string, kind: OperationDraftKind) {
  try {
    localStorage.removeItem(storageKey(ownerId, episodeId, kind));
  } catch {
    // 忽略本地存储不可用的情况。
  }
}
