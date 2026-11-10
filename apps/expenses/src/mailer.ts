import { Pool } from "pg";
import type { EventType } from "./events";
import type { Identity } from "./identity";
import { NOTIFIABLE, NotifyRequest, notificationsFor } from "./notify";
import { getSetting } from "./settings";
import { config } from "./config";
import { runDigest } from "./digest";

type Db = Pick<Pool, "query">;
export type FetchFn = typeof fetch;

export interface MailConfig {
  key: string;
  from: string;
}

// Mail is on when both a Resend key and a from address are saved.
export async function mailConfig(db: Db): Promise<MailConfig | null> {
  const key = (await getSetting(db, "resend_api_key")).trim();
  const from = (await getSetting(db, "mail_from")).trim();
  return key && from ? { key, from } : null;
}

// Called by addEvent, inside the same transaction as the event, so an email is
// queued if and only if the thing it describes really happened. With mail off
// nothing is queued at all — switching it on later must not send a backlog.
export async function queueNotifications(
  db: Db,
  requestId: number,
  type: EventType,
  actor: Identity,
  comment: string,
  meta: Record<string, unknown> | null
): Promise<void> {
  if (!NOTIFIABLE.has(type)) return;
  if (!(await mailConfig(db))) return;

  const r = await db.query<NotifyRequest>(
    `SELECT id::int AS id, kind, payment_method, status, submitted_by_email, purchased_by_email,
            approver_email, amount::float8 AS amount, estimated_amount::float8 AS estimated_amount,
            approved_amount::float8 AS approved_amount, approved_at, actuals_completed_at,
            reimbursed_at, voided_at, version, vendor, reason, submitted_by
       FROM requests WHERE id = $1`,
    [requestId]
  );
  if (!r.rows[0]) return;
  const payers = (await db.query<{ email: string }>("SELECT email FROM app_users WHERE can_pay"))
    .rows.map((p) => p.email);

  const drafts = notificationsFor(type, r.rows[0], {
    actorEmail: actor.email,
    actorName: actor.name,
    comment,
    meta,
    payers,
    appUrl: config.appUrl,
    orgName: await getSetting(db, "org_name"),
  });
  for (const d of drafts) {
    await db.query(
      `INSERT INTO notifications (request_id, to_email, kind, subject, body) VALUES ($1, $2, $3, $4, $5)`,
      [requestId, d.to, d.kind, d.subject, d.body]
    );
  }
}

export type SendResult = { ok: true } | { ok: false; error: string };

export async function sendViaResend(
  fetchFn: FetchFn,
  mail: MailConfig,
  msg: { to: string; subject: string; body: string; idempotencyKey?: string }
): Promise<SendResult> {
  try {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${mail.key}`,
        "content-type": "application/json",
        ...(msg.idempotencyKey ? { "idempotency-key": msg.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: mail.from, to: [msg.to], subject: msg.subject, text: msg.body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `Resend ${res.status}: ${detail.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Could not reach Resend." };
  }
}

export const MAX_ATTEMPTS = 5;

// Sends what is due. Rows are locked while they are sent so two runs can never
// send the same email; the idempotency key covers a crash between Resend
// accepting a message and the row being marked sent.
export async function deliverPending(pool: Pool, fetchFn: FetchFn = fetch, limit = 10): Promise<number> {
  const client = await pool.connect();
  let sent = 0;
  try {
    await client.query("BEGIN");
    const mail = await mailConfig(client);
    if (!mail) {
      await client.query("COMMIT");
      return 0;
    }
    const due = await client.query<{ id: number; to_email: string; subject: string; body: string; attempts: number }>(
      `SELECT id::int AS id, to_email, subject, body, attempts FROM notifications
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    for (const n of due.rows) {
      const out = await sendViaResend(fetchFn, mail, {
        to: n.to_email, subject: n.subject, body: n.body, idempotencyKey: `expenses-${n.id}`,
      });
      if (out.ok) {
        sent += 1;
        await client.query(
          "UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1",
          [n.id]
        );
      } else {
        const attempts = n.attempts + 1;
        // Back off 1, 4, 9, 16 minutes; give up on the fifth failure.
        await client.query(
          `UPDATE notifications
              SET attempts = $2::int, last_error = $3,
                  status = CASE WHEN $2::int >= $4::int THEN 'failed' ELSE 'pending' END,
                  next_attempt_at = now() + make_interval(mins => $2::int * $2::int)
            WHERE id = $1`,
          [n.id, attempts, out.error, MAX_ATTEMPTS]
        );
      }
    }
    await client.query("COMMIT");
    return sent;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function startMailer(pool: Pool, log: { error(obj: unknown, msg?: string): void }): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDigest(pool);
      await deliverPending(pool);
    } catch (err) {
      log.error(err, "expenses: sending notifications failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 20_000);
  timer.unref();
  return () => clearInterval(timer);
}
