// Grace Notes reminder email via Resend. The send contract is copied from apps/expenses/src/mailer.ts.
import { Pool } from "pg";
import { getSetting } from "../settings";
import { getIssue, label } from "./issues";
import { listContributors } from "./repo";

export type FetchFn = typeof fetch;
export type SendResult = { ok: true } | { ok: false; error: string };
export type ReminderKind = "monday" | "deadline" | "manual";

export async function sendMail(
  fetchFn: FetchFn,
  cfg: { key: string; from: string },
  msg: { to: string; subject: string; text: string; idempotencyKey?: string },
): Promise<SendResult> {
  try {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.key}`,
        "content-type": "application/json",
        ...(msg.idempotencyKey ? { "idempotency-key": msg.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: cfg.from, to: [msg.to], subject: msg.subject, text: msg.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `Resend ${res.status}: ${detail.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Could not reach Resend." };
  }
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clockWords(hhmm: string): string {
  if (hhmm === "12:00") return "noon";
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

export async function remind(
  db: Pool, issueId: string, contributorId: string, kind: ReminderKind, fetchFn: FetchFn = fetch,
): Promise<{ status: "sent" | "failed" | "skipped"; error?: string }> {
  const auto = kind !== "manual";
  const [key, from, base] = await Promise.all([
    getSetting(db, "resend_api_key"), getSetting(db, "mail_from"), getSetting(db, "public_base_url"),
  ]);
  const issue = await getIssue(db, issueId);
  const person = (await listContributors(db)).find((c) => c.id === contributorId);
  const missing = !key.trim() || !from.trim() || !base.trim() ? "Email isn't set up."
    : !issue || !person ? "Issue or contributor not found."
    : person.retired ? "Contributor is retired."
    : !person.email.trim() ? "Contributor has no email."
    : "";
  if (missing || !issue || !person) {
    // Automatic kinds leave no row: a skipped row would block the real send once mail is switched on.
    if (!auto && issue && person) {
      await db.query("INSERT INTO gn_reminders (issue_id, contributor_id, kind, status, error) VALUES ($1,$2,$3,'skipped',$4)",
        [issueId, contributorId, kind, missing]);
    }
    return { status: "skipped", error: missing };
  }
  const ins = await db.query(
    `INSERT INTO gn_reminders (issue_id, contributor_id, kind, status) VALUES ($1,$2,$3,'failed')
     ON CONFLICT DO NOTHING RETURNING id`, [issueId, contributorId, kind]);
  if (!ins.rows[0]) return { status: "skipped", error: "Already sent." };

  const sendDay = DAYS[new Date(`${issue.issueDate}T12:00:00Z`).getUTCDay()];
  const deadlineDay = DAYS[(new Date(`${issue.issueDate}T12:00:00Z`).getUTCDay() + 6) % 7];
  const deadlineAt = (await getSetting(db, "gn_deadline_at")) || "12:00";
  const link = `${base.trim().replace(/\/+$/, "")}/gn/${person.token}`;
  const text = `Grace Notes goes out ${sendDay}. Check your piece by ${deadlineDay} ${clockWords(deadlineAt)}:\n\n${link}\n`;
  const out = await sendMail(fetchFn, { key: key.trim(), from: from.trim() }, {
    to: person.email.trim(), subject: `Grace Notes for ${label(issue.issueDate)}: please check your piece`, text,
    idempotencyKey: `gn-${issueId}-${contributorId}-${kind}`,
  });
  await db.query("UPDATE gn_reminders SET status = $2, error = $3 WHERE id = $1",
    [ins.rows[0].id, out.ok ? "sent" : "failed", out.ok ? "" : out.error]);
  return out.ok ? { status: "sent" } : { status: "failed", error: out.error };
}
