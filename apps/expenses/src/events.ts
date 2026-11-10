import { Pool } from "pg";
import { Identity } from "./identity";
import { queueNotifications } from "./mailer";

export type EventType =
  | "submitted"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "approved_on_paper"
  | "comment"
  | "receipt_added"
  | "receipt_removed"
  | "actuals_completed"
  | "reapproval_required"
  | "reimbursed"
  | "edited"
  | "withdrawn"
  | "resubmitted"
  | "voided"
  | "reminded"
  | "reassigned";

export interface RequestEvent {
  id: number;
  type: EventType;
  actor_email: string;
  actor_name: string;
  comment: string;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export async function addEvent(
  pool: Pick<Pool, "query">,
  requestId: number,
  type: EventType,
  actor: Identity,
  comment = "",
  meta: Record<string, unknown> | null = null
): Promise<void> {
  await pool.query(
    `INSERT INTO request_events (request_id, type, actor_email, actor_name, comment, meta)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [requestId, type, actor.email, actor.name, comment, meta ? JSON.stringify(meta) : null]
  );
  // Same connection, so inside the caller's transaction when there is one.
  await queueNotifications(pool, requestId, type, actor, comment, meta);
}

export async function listEvents(pool: Pool, requestId: number): Promise<RequestEvent[]> {
  const r = await pool.query<RequestEvent>(
    `SELECT id::int AS id, type, actor_email, actor_name, comment, meta, created_at
       FROM request_events WHERE request_id = $1 ORDER BY created_at, id`,
    [requestId]
  );
  return r.rows;
}
