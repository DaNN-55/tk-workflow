import { describe, expect, it } from "vitest";
import { formatSnapshotFilename, snapshotTables } from "./backupPolicy";

describe("Supabase 数据快照策略", () => {
  it("使用可排序的 UTC 文件名", () => {
    expect(formatSnapshotFilename(new Date("2026-08-13T01:02:03.456Z"))).toBe("supabase-snapshot-2026-08-13T01-02-03-456Z.json");
  });

  it("为每张表固定分页排序，且包含 Worker 的付费调用记录", () => {
    expect(snapshotTables.task_runs).toEqual({ order: "id.asc", boundaryColumn: "started_at" });
    expect(snapshotTables.account_memberships).toEqual({ order: "account_id.asc,user_id.asc" });
  });
});
