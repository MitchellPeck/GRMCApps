// The Monday/Thursday reminder email (spec §7): what is overdue or due soon, what the Breeze sync brought in,
// and which events have nothing planned. One plain-text email per owner, sent once per due slot.
import { Pool } from "pg";
import { DEFAULT_TZ, addDays, formatMonthDayYear, localDateIn, localTimeIn, weekdayOf } from "../dates";
import { FetchFn, sendMail } from "../gracenotes/mail";
import { getSetting, setSetting } from "../settings";
import { GAP_THRESHOLDS } from "./config";
import { DONE_MEDIA, READY_STATUSES } from "./rules";

export interface DigestLine { text: string; url: string }
export interface Digest {
  to: string;
  overdue: DigestLine[]; dueSoon: DigestLine[]; newEvents: DigestLine[];
  nowRepeating: DigestLine[]; removed: DigestLine[]; noChecklist: DigestLine[];
}

const SEND_DAYS = [1, 4]; // Monday, Thursday
const SEND_AT = "08:00";
const FIRST_EMAIL_DAYS = 30;
const OVERDUE_DAYS = 30; // older than this is history, not a reminder

/** The date to send for, if a send is due now and not already done. A late start still sends the same day. */
export function digestSlot(now: { date: string; time: string }, lastSlot: string): string | null {
  if (!SEND_DAYS.includes(weekdayOf(now.date)) || now.time < SEND_AT) return null;
  return lastSlot === now.date ? null : now.date;
}

const LIST_KEYS = ["overdue", "dueSoon", "newEvents", "nowRepeating", "removed", "noChecklist"] as const;
type ListKey = typeof LIST_KEYS[number];

export async function buildDigests(
  db: Pool, today: string, since: string | null, baseUrl: string, defaultOwner: string,
): Promise<Digest[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const soon = addDays(today, GAP_THRESHOLDS.dueSoonDays);
  const oldest = addDays(today, -OVERDUE_DAYS);
  const byOwner = new Map<string, Digest>();
  // Anything with nobody to send it to is left out: there is no one to remind.
  const add = (owner: string, list: ListKey, text: string, eventId: string | null) => {
    const to = (owner || "").trim() || defaultOwner.trim();
    if (!to) return;
    const key = to.toLowerCase();
    let d = byOwner.get(key);
    if (!d) {
      d = { to, overdue: [], dueSoon: [], newEvents: [], nowRepeating: [], removed: [], noChecklist: [] };
      byOwner.set(key, d);
    }
    d[list].push({ text, url: eventId ? `${base}/#event/${eventId}` : `${base}/#calendar` });
  };
  const when = (d: string) => formatMonthDayYear(d);
  const where = (name: string | null) => (name ? ` (${name})` : "");

  // Posts: overdue is a day in the last 30 that passed without the post being scheduled or published (a Ready
  // post nobody sent counts); due soon is not yet ready within the window.
  const posts = await db.query(
    `SELECT c.title, c.publish_date::text AS d, c.event_id, e.name AS event_name,
            COALESCE(NULLIF(c.owner_email, ''), e.owner_email, '') AS owner
       FROM content_items c LEFT JOIN events e ON e.id = c.event_id
      WHERE c.status <> 'cancelled' AND c.publish_date BETWEEN $3 AND $2
        AND CASE WHEN c.publish_date < $4 THEN c.status NOT IN ('scheduled', 'published') ELSE c.status <> ALL($1) END
        AND COALESCE(e.archived, false) = false
      ORDER BY c.publish_date, c.title`, [READY_STATUSES, soon, oldest, today]);
  for (const r of posts.rows) {
    const overdue = r.d < today;
    add(r.owner, overdue ? "overdue" : "dueSoon",
      `Post "${r.title}"${where(r.event_name)}: ${overdue ? "was due" : "due"} ${when(r.d)}`, r.event_id);
  }

  // Graphics/media to collect: a post's follow the post's owner, an event's follow the event's.
  const media = await db.query(
    `SELECT m.description, m.gather_date::text AS d, COALESCE(m.event_id, c.event_id) AS event_id, e.name AS event_name,
            CASE WHEN m.content_item_id IS NOT NULL THEN COALESCE(NULLIF(c.owner_email, ''), e.owner_email, '')
                 ELSE e.owner_email END AS owner
       FROM media_assets m
       LEFT JOIN content_items c ON c.id = m.content_item_id
       LEFT JOIN events e ON e.id = COALESCE(m.event_id, c.event_id)
      WHERE m.kind = 'collect' AND m.gather_date BETWEEN $3 AND $2 AND m.status <> ALL($1)
        AND (c.id IS NULL OR c.status <> 'cancelled') AND COALESCE(e.archived, false) = false
      ORDER BY m.gather_date, m.description`, [DONE_MEDIA, soon, oldest]);
  for (const r of media.rows) {
    const overdue = r.d < today;
    add(r.owner, overdue ? "overdue" : "dueSoon",
      `Graphic "${r.description}"${where(r.event_name)}: ${overdue ? "was due" : "due"} ${when(r.d)}`, r.event_id);
  }

  // Breeze events: new since the last email (the first one only looks 30 days ahead), then repeats, removals, gaps.
  const fresh = since
    ? await db.query(
      `SELECT id, name, owner_email, start_date::text AS d FROM events
        WHERE source = 'breeze' AND NOT archived AND breeze_missing_since IS NULL AND created_at > $1::timestamptz
        ORDER BY start_date, name`, [since])
    : await db.query(
      `SELECT id, name, owner_email, start_date::text AS d FROM events
        WHERE source = 'breeze' AND NOT archived AND breeze_missing_since IS NULL AND start_date BETWEEN $1 AND $2
        ORDER BY start_date, name`, [today, addDays(today, FIRST_EMAIL_DAYS)]);
  for (const r of fresh.rows) add(r.owner_email, "newEvents", `${r.name}${r.d ? `, ${when(r.d)}` : ""}`, r.id);

  if (since) {
    const rep = await db.query(
      `SELECT e.id, e.name, e.owner_email FROM events e JOIN breeze_series s ON s.breeze_event_id = e.breeze_event_id
        WHERE e.source = 'breeze' AND e.breeze_instance_id IS NULL AND NOT e.archived
          AND s.became_series_at > $1::timestamptz ORDER BY e.name`, [since]);
    for (const r of rep.rows) add(r.owner_email, "nowRepeating", `${r.name} now repeats`, r.id);
  }

  const gone = await db.query(
    `SELECT id, name, owner_email FROM events WHERE source = 'breeze' AND NOT archived AND breeze_missing_since IS NOT NULL ORDER BY name`);
  for (const r of gone.rows) add(r.owner_email, "removed", `${r.name} is no longer in Breeze`, r.id);

  const bare = await db.query(
    `SELECT e.id, e.name, e.owner_email, e.start_date::text AS d FROM events e
      WHERE e.source = 'breeze' AND NOT e.archived AND e.breeze_missing_since IS NULL
        AND e.start_date BETWEEN $1 AND $2
        AND NOT EXISTS (SELECT 1 FROM content_items c WHERE c.event_id = e.id AND c.status <> 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.event_id = e.id)
      ORDER BY e.start_date, e.name`, [today, addDays(today, GAP_THRESHOLDS.noChecklistDays)]);
  for (const r of bare.rows) add(r.owner_email, "noChecklist", `${r.name}, ${when(r.d)}`, r.id);

  return [...byOwner.values()].sort((a, b) => a.to.localeCompare(b.to));
}

const SECTIONS: Array<[ListKey, string]> = [
  ["overdue", "Overdue"], ["dueSoon", "Due this week"], ["newEvents", "New events from Breeze"],
  ["nowRepeating", "Events that now repeat"], ["removed", "Removed from Breeze"], ["noChecklist", "Nothing planned yet"],
];

export function digestText(d: Digest): { subject: string; text: string } | null {
  if (LIST_KEYS.every((k) => d[k].length === 0)) return null;
  const parts: string[] = [];
  if (d.overdue.length) parts.push(`${d.overdue.length} overdue`);
  if (d.dueSoon.length) parts.push(`${d.dueSoon.length} due this week`);
  const subject = `Social posts: ${parts.length ? parts.join(", ") : "updates from Breeze"}`;
  const body = SECTIONS.filter(([k]) => d[k].length)
    .map(([k, title]) => `${title}\n${d[k].map((l) => `- ${l.text}\n  ${l.url}`).join("\n")}`);
  return { subject, text: `${body.join("\n\n")}\n` };
}

/** One 15-minute tick: send each owner's email when a slot is due; the slot is only marked done if every send worked. */
export async function digestTick(
  pool: Pool, now: Date = new Date(), fetchFn: FetchFn = fetch,
): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };
  const [key, from, base, tzSetting, owner, lastSlot, lastSent] = await Promise.all([
    "resend_api_key", "mail_from", "public_base_url", "default_timezone", "breeze_default_owner",
    "digest_last_slot", "digest_last_sent_at",
  ].map((k) => getSetting(pool, k)));
  if (!key.trim() || !from.trim() || !base.trim()) return result;
  const tz = tzSetting || DEFAULT_TZ;
  const today = localDateIn(tz, now);
  const slot = digestSlot({ date: today, time: localTimeIn(tz, now) }, lastSlot);
  if (!slot) return result;

  const digests = await buildDigests(pool, today, lastSent.trim() || null, base, owner);
  for (const d of digests) {
    const mail = digestText(d);
    if (!mail) continue;
    const r = await sendMail(fetchFn, { key: key.trim(), from: from.trim() }, { to: d.to, ...mail, idempotencyKey: `digest-${slot}-${d.to.toLowerCase()}` });
    if (r.ok) result.sent += 1;
    else { result.failed += 1; console.warn(`[digest] send to ${d.to} failed:`, r.error); }
  }
  if (result.failed === 0) {
    await setSetting(pool, "digest_last_slot", slot);
    await setSetting(pool, "digest_last_sent_at", now.toISOString());
  }
  return result;
}
