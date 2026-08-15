export interface AuditEvent {
  id: string;
  createdAt: string;
  eventType: string;
  payload: unknown;
}

export interface NotificationCursor {
  createdAt: string;
  id: string;
}

export interface NotificationSelection {
  approvalStages: string[];
  blockerDetails: string[];
  stateStages: string[];
  nextCursor: NotificationCursor | null;
}

export function collectNotifications(
  auditEvents: AuditEvent[],
  cursor: NotificationCursor | null,
): NotificationSelection {
  const sortedEvents = [...auditEvents].sort(compareEvents);
  const nextCursor = toCursor(sortedEvents.at(-1));

  if (!cursor) return { approvalStages: [], blockerDetails: [], stateStages: [], nextCursor };

  const approvalStages: string[] = [];
  const blockerDetails: string[] = [];
  const stateStages: string[] = [];
  for (const event of sortedEvents) {
    if (!isAfterCursor(event, cursor)) continue;
    if (event.eventType === "stage_transition") {
      const stage = stageFromPayload(event.payload);
      if (!stage) continue;
      if (stage.endsWith("_review")) approvalStages.push(stage);
      else stateStages.push(stage);
    } else if (event.eventType === "a_roll_task_blocked" || event.eventType === "b_roll_task_blocked") {
      const detail = blockerDetailFromPayload(event.payload);
      if (detail) blockerDetails.push(detail);
    }
  }

  return { approvalStages, blockerDetails, stateStages, nextCursor };
}

function compareEvents(left: AuditEvent, right: AuditEvent): number {
  return comparePositions(left, right);
}

function isAfterCursor(event: AuditEvent, cursor: NotificationCursor): boolean {
  return comparePositions(event, cursor) > 0;
}

function comparePositions(left: NotificationCursor, right: NotificationCursor): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function toCursor(event: AuditEvent | undefined): NotificationCursor | null {
  return event ? { createdAt: event.createdAt, id: event.id } : null;
}

function stageFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const stage = payload.to_stage;
  return typeof stage === "string" && stage.length > 0 ? stage : null;
}

function blockerDetailFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const { code, detail, shot_id: shotId } = payload;
  if (typeof code !== "string" || !code || typeof detail !== "string" || !detail) return null;
  return typeof shotId === "string" && shotId ? `${shotId} · ${code}: ${detail}` : `${code}: ${detail}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
