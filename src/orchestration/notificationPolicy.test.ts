import { describe, expect, it } from "vitest";
import { collectNotifications, type AuditEvent } from "./notificationPolicy";

const events: AuditEvent[] = [
  {
    id: "event-1",
    createdAt: "2026-08-12T10:00:00.000Z",
    eventType: "stage_transition",
    payload: { to_stage: "script_review" },
  },
  {
    id: "event-2",
    createdAt: "2026-08-12T10:01:00.000Z",
    eventType: "stage_transition",
    payload: { to_stage: "script_approved" },
  },
  {
    id: "event-3",
    createdAt: "2026-08-12T10:02:00.000Z",
    eventType: "worker_task_claimed",
    payload: {},
  },
];

describe("n8n 通知策略", () => {
  it("首次建立游标时不回放历史审计事件", () => {
    expect(collectNotifications(events, null)).toEqual({
      approvalStages: [],
      stateStages: [],
      nextCursor: { createdAt: "2026-08-12T10:02:00.000Z", id: "event-3" },
    });
  });

  it("把审核状态与普通状态迁移分开通知", () => {
    expect(collectNotifications(events, { createdAt: "2026-08-12T09:59:00.000Z", id: "" })).toEqual({
      approvalStages: ["script_review"],
      stateStages: ["script_approved"],
      nextCursor: { createdAt: "2026-08-12T10:02:00.000Z", id: "event-3" },
    });
  });

  it("以创建时间和事件 ID 共同推进游标，避免同一时间戳的重复通知", () => {
    const sameTimeEvents: AuditEvent[] = [
      {
        id: "event-a",
        createdAt: "2026-08-12T10:00:00.000Z",
        eventType: "stage_transition",
        payload: { to_stage: "visual_review" },
      },
      {
        id: "event-b",
        createdAt: "2026-08-12T10:00:00.000Z",
        eventType: "stage_transition",
        payload: { to_stage: "visual_approved" },
      },
    ];

    expect(collectNotifications(sameTimeEvents, { createdAt: "2026-08-12T10:00:00.000Z", id: "event-a" })).toEqual({
      approvalStages: [],
      stateStages: ["visual_approved"],
      nextCursor: { createdAt: "2026-08-12T10:00:00.000Z", id: "event-b" },
    });
  });
});
