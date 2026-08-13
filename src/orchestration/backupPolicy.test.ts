import { describe, expect, it } from "vitest";
import { backupFilesToRemove, formatBackupFilename } from "./backupPolicy";

describe("Supabase 逻辑备份策略", () => {
  it("使用可排序的 UTC 文件名", () => {
    expect(formatBackupFilename(new Date("2026-08-13T01:02:03.456Z"))).toBe("supabase-2026-08-13T01-02-03-456Z.json");
  });

  it("只删除超过保留数量的匹配备份", () => {
    const files = [
      "notes.txt",
      "supabase-2026-08-12T01-00-00-000Z.json",
      "supabase-2026-08-13T01-00-00-000Z.json",
      "supabase-2026-08-11T01-00-00-000Z.json",
    ];

    expect(backupFilesToRemove(files, 2)).toEqual(["supabase-2026-08-11T01-00-00-000Z.json"]);
  });
});
