import { Pool } from "pg";
import { config } from "./config";
import { mailConfig } from "./mailer";
import { getSetting } from "./settings";
import { STEP_EVENTS } from "./requests";
import { CHURCH_TIME_ZONE, todayIso } from "./validate";

// The morning email: each approver hears what is waiting for them, and
// whoever pays hears what is ready to pay. Sent once a day, after DIGEST_HOUR
// church time, and only when an admin has switched it on.

export const DIGEST_HOUR = 8;

export interface DigestRow {
  id: number;
  amount: number;
  estimated_amount: number | null;
  vendor: string;
  reason: string;
  submitted_by: string;
  approver_email: string;
  purchased_by_email: string;
  submitted_by_email: string;
  step_since: string | Date;
}

export interface DigestDraft {
  to: string;
  subject: string;
  body: string;
}

const money = (n: number | null | undefined) =>
  "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function days(since: string | Date, now: Date): string {
  const d = Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000);
  return d <= 0 ? "since today" : d === 1 ? "1 day" : `${d} days`;
}

function line(r: DigestRow, now: Date, appUrl: string, amount: number | null): string {
  const what = (r.vendor || r.reason || `request #${r.id}`).trim();
  const who = r.submitted_by ? ` (${r.submitted_by})` : "";
  const link = appUrl ? `\n    ${appUrl.replace(/\/$/, "")}/#/r/${r.id}` : "";
  return `- ${money(amount)} — ${what}${who}, waiting ${days(r.step_since, now)}${link}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function digestsFor(
  pending: DigestRow[],
  ready: DigestRow[],
  payers: string[],
  ctx: { now: Date; appUrl: string; orgName: string }
): DigestDraft[] {
  const sign = `\n\n— ${ctx.orgName ? ctx.orgName + " " : ""}Expenses`;
  const out: DigestDraft[] = [];

  const byApprover = new Map<string, DigestRow[]>();
  for (const r of pending) {
    const key = r.approver_email.trim().toLowerCase();
    if (!key.includes("@")) continue;
    byApprover.set(key, [...(byApprover.get(key) ?? []), r]);
  }
  for (const [to, rows] of byApprover) {
    out.push({
      to,
      subject: `${plural(rows.length, "request is", "requests are")} waiting for your approval`,
      body: `Good morning. These are waiting for you to approve:\n\n` +
        rows.map((r) => line(r, ctx.now, ctx.appUrl, r.estimated_amount ?? r.amount)).join("\n") + sign,
    });
  }

  for (const payer of new Set(payers.map((p) => p.trim().toLowerCase()))) {
    // Never ask someone to pay themselves.
    const mine = ready.filter((r) => (r.purchased_by_email || r.submitted_by_email).trim().toLowerCase() !== payer);
    if (!mine.length) continue;
    const total = mine.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    out.push({
      to: payer,
      subject: `${plural(mine.length, "reimbursement", "reimbursements")} ready to pay (${money(total)})`,
      body: `Good morning. These are approved and ready to be paid back:\n\n` +
        mine.map((r) => line(r, ctx.now, ctx.appUrl, r.amount)).join("\n") +
        `\n\nYou can pay several at once from the Office tab.` + sign,
    });
  }
  return out;
}

export function hourIn(now: Date, timeZone = CHURCH_TIME_ZONE): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
}

const ROW = `id::int AS id, amount::float8 AS amount, estimated_amount::float8 AS estimated_amount,
  vendor, reason, submitted_by, approver_email, purchased_by_email, submitted_by_email,
  COALESCE((SELECT max(e.created_at) FROM request_events e
             WHERE e.request_id = r.id AND e.type IN (${STEP_EVENTS})), r.created_at) AS step_since`;

// Called from the mailer's tick. Claims the day with one conditional upsert
// before writing anything, so two processes, or a restart mid-morning, can
// never send it twice. Returns how many emails were queued.
export async function runDigest(pool: Pool, now = new Date()): Promise<number> {
  if ((await getSetting(pool, "daily_digest")) !== "true") return 0;
  if (hourIn(now) < DIGEST_HOUR) return 0;
  if (!(await mailConfig(pool))) return 0;
  const today = todayIso(now);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('digest_last_sent', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
         WHERE settings.value <> EXCLUDED.value
       RETURNING key`,
      [today]
    );
    if (!claim.rowCount) {
      await client.query("ROLLBACK");
      return 0;
    }
    const pending = (await client.query<DigestRow>(
      `SELECT ${ROW} FROM requests r WHERE status = 'pending' ORDER BY step_since, id`
    )).rows;
    const ready = (await client.query<DigestRow>(
      `SELECT ${ROW} FROM requests r
        WHERE status = 'approved' AND payment_method = 'reimbursement' AND reimbursed_at IS NULL
          AND (kind = 'post_purchase' OR actuals_completed_at IS NOT NULL)
        ORDER BY step_since, id`
    )).rows;
    const payers = (await client.query<{ email: string }>("SELECT email FROM app_users WHERE can_pay")).rows
      .map((p) => p.email);
    const drafts = digestsFor(pending, ready, payers, {
      now, appUrl: config.appUrl, orgName: await getSetting(client, "org_name"),
    });
    for (const d of drafts) {
      await client.query(
        "INSERT INTO notifications (request_id, to_email, kind, subject, body) VALUES (NULL, $1, 'digest', $2, $3)",
        [d.to, d.subject, d.body]
      );
    }
    await client.query("COMMIT");
    return drafts.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
