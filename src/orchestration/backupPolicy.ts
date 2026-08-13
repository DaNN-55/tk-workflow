export const snapshotTables = {
  accounts: { order: "id.asc", boundaryColumn: "created_at" },
  account_blueprint_versions: { order: "id.asc", boundaryColumn: "created_at" },
  account_memberships: { order: "account_id.asc,user_id.asc", boundaryColumn: undefined },
  episodes: { order: "id.asc", boundaryColumn: "created_at" },
  tasks: { order: "id.asc", boundaryColumn: "created_at" },
  task_runs: { order: "id.asc", boundaryColumn: "started_at" },
  artifacts: { order: "id.asc", boundaryColumn: "created_at" },
  approvals: { order: "id.asc", boundaryColumn: "created_at" },
  state_transitions: { order: "id.asc", boundaryColumn: "created_at" },
  audit_events: { order: "id.asc", boundaryColumn: "created_at" },
  experiments: { order: "id.asc", boundaryColumn: "created_at" },
  metric_snapshots: { order: "id.asc", boundaryColumn: "captured_at" },
  asset_locks: { order: "resource_key.asc", boundaryColumn: "locked_at" },
} as const;

export type SnapshotTable = keyof typeof snapshotTables;

export function formatSnapshotFilename(createdAt: Date): string {
  return `supabase-snapshot-${createdAt.toISOString().replaceAll(":", "-").replace(".", "-")}.json`;
}
