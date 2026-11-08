// Grace Notes issues: one per week, each seeded from the previous so contributors only confirm or edit.
import { createHash } from "node:crypto";
import { Pool, PoolClient } from "pg";
import { Result } from "../pipeline/rules";
import { addDays, weekdayOf } from "../dates";
import { listSections, withTx } from "./repo";
import { Details, Section } from "./types";

type Db = Pool | PoolClient;

export interface Issue { id: string; issueDate: string; status: "collecting" | "sent"; createdAt: string; sentAt: string | null }
export type ContributorState = "outstanding" | "confirmed" | "changed" | "new" | "none";

const ISSUE_COLS = "id, to_char(issue_date,'YYYY-MM-DD') AS issue_date, status, created_at, sent_at";
const issueRow = (r: Record<string, unknown>): Issue => ({
  id: r.id as string, issueDate: r.issue_date as string, status: r.status as Issue["status"],
  createdAt: new Date(r.created_at as string).toISOString(),
  sentAt: r.sent_at ? new Date(r.sent_at as string).toISOString() : null,
});

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]));
  }
  return v;
}

export function pieceHash(p: { title: string; bodyHtml: string; details: Details; imageUrl: string; eventId: string | null }): string {
  const json = JSON.stringify(canonical({ title: p.title, bodyHtml: p.bodyHtml, details: p.details, imageUrl: p.imageUrl, eventId: p.eventId ?? null }));
  return createHash("sha256").update(json).digest("hex");
}

export async function getIssue(db: Db, id: string): Promise<Issue | null> {
  const { rows } = await db.query(`SELECT ${ISSUE_COLS} FROM gn_issues WHERE id = $1`, [id]);
  return rows[0] ? issueRow(rows[0]) : null;
}

export async function listIssues(db: Db): Promise<Issue[]> {
  const { rows } = await db.query(`SELECT ${ISSUE_COLS} FROM gn_issues ORDER BY issue_date DESC`);
  return rows.map(issueRow);
}

/** The newest issue still collecting, else the newest of all. */
export async function currentIssue(db: Db): Promise<Issue | null> {
  const { rows } = await db.query(
    `SELECT ${ISSUE_COLS} FROM gn_issues ORDER BY (status = 'collecting') DESC, issue_date DESC LIMIT 1`);
  return rows[0] ? issueRow(rows[0]) : null;
}

export async function createIssue(db: Db, issueDate: string): Promise<Result<Issue>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate ?? "")) return { ok: false, error: "Issue date must be YYYY-MM-DD." };
  const dup = await db.query("SELECT 1 FROM gn_issues WHERE issue_date = $1", [issueDate]);
  if (dup.rows.length) return { ok: false, error: `There's already an issue for ${issueDate}.` };
  try {
    return await withTx(db, async (c): Promise<Result<Issue>> => {
      const ins = await c.query(`INSERT INTO gn_issues (issue_date) VALUES ($1) RETURNING ${ISSUE_COLS}`, [issueDate]);
      const issue = issueRow(ins.rows[0]);
      const prev = await c.query("SELECT id FROM gn_issues WHERE issue_date < $1 ORDER BY issue_date DESC LIMIT 1", [issueDate]);
      if (prev.rows[0]) {
        // Undated, unlinked items stay until someone drops them; endDate only matters when present.
        await c.query(
          `INSERT INTO gn_pieces (issue_id, section_id, contributor_id, event_id, title, body_html, details, image_url,
                                  status, position, carried_from, content_hash, updated_by)
           SELECT $1, p.section_id, p.contributor_id, p.event_id, p.title, p.body_html, p.details, p.image_url,
                  'carried', p.position, p.id, p.content_hash, ''
             FROM gn_pieces p
             JOIN gn_sections s ON s.id = p.section_id
             LEFT JOIN events e ON e.id = p.event_id
            WHERE p.issue_id = $2 AND p.status <> 'dropped' AND NOT s.retired AND s.kind <> 'glance'
              AND NOT COALESCE(e.id IS NOT NULL AND COALESCE(e.end_date, e.start_date) < $3::date, false)
              AND NOT COALESCE(p.event_id IS NULL AND p.details->>'endDate' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND p.details->>'endDate' < $3::text, false)`,
          [issue.id, prev.rows[0].id, issueDate]);
      }
      await fillTextSections(c, issue.id);
      return { ok: true, value: issue };
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, error: `There's already an issue for ${issueDate}.` };
    throw e;
  }
}

/** Gives the issue an empty piece for every live text section it lacks. Returns how many were added. */
async function fillTextSections(db: Db, issueId: string): Promise<number> {
  const empty = pieceHash({ title: "", bodyHtml: "", details: {}, imageUrl: "", eventId: null });
  const r = await db.query(
    `INSERT INTO gn_pieces (issue_id, section_id, status, content_hash)
     SELECT $1, s.id, 'carried', $2 FROM gn_sections s
      WHERE s.kind = 'text' AND NOT s.retired
        AND NOT EXISTS (SELECT 1 FROM gn_pieces p WHERE p.issue_id = $1 AND p.section_id = s.id)`,
    [issueId, empty]);
  return r.rowCount ?? 0;
}

/**
 * A section added (or brought back) while an issue is open belongs in that issue too, not only from next week.
 * Sent issues are left as they went out. Safe to run any number of times.
 */
export async function fillOpenIssues(db: Db): Promise<number> {
  const { rows } = await db.query("SELECT id FROM gn_issues WHERE status = 'collecting'");
  let added = 0;
  for (const r of rows) added += await fillTextSections(db, r.id);
  return added;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const label = (iso: string) => `${DAY[weekdayOf(iso)]} ${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Every non-archived event starting in the four weeks from issueDate, in date order. */
export async function glanceHtml(db: Db, issueDate: string): Promise<string> {
  const { rows } = await db.query(
    `SELECT name, to_char(start_date,'YYYY-MM-DD') AS s, to_char(end_date,'YYYY-MM-DD') AS e
       FROM events WHERE NOT archived AND start_date BETWEEN $1::date AND $2::date
      ORDER BY start_date, name`,
    [issueDate, addDays(issueDate, 27)]);
  const items = rows.map((r) => {
    const when = r.e && r.e > r.s ? `${label(r.s)} – ${label(r.e)}` : label(r.s);
    return `<li><strong>${when}</strong> · ${esc(r.name)}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

export function pieceOwnerIds(piece: { contributorId: string | null; sectionId: string }, sections: Section[]): string[] {
  if (piece.contributorId) return [piece.contributorId];
  return sections.find((s) => s.id === piece.sectionId)?.ownerIds ?? [];
}

export async function contributorStatus(db: Db, issueId: string): Promise<Array<{
  contributorId: string; name: string; state: ContributorState; pieces: number; lastReminder: string | null;
  /** Has an email address, so a Nudge can go; otherwise the admin copies the link. */
  hasEmail: boolean;
  /** Owns a live events section, so gets Monday's "anything new?" email even with no pieces (R21). */
  ownsEvents: boolean;
}>> {
  const sections = await listSections(db, { includeRetired: true });
  // Pieces in retired sections don't count, matching what the contributor's page shows.
  const { rows: pieces } = await db.query(
    `SELECT p.section_id, p.contributor_id, p.status FROM gn_pieces p JOIN gn_sections s ON s.id = p.section_id
      WHERE p.issue_id = $1 AND p.status <> 'dropped' AND NOT s.retired`, [issueId]);
  const { rows: people } = await db.query(
    `SELECT c.id, c.name, c.email, (SELECT max(created_at) FROM gn_reminders r WHERE r.issue_id = $1 AND r.contributor_id = c.id AND r.status = 'sent') AS last
       FROM gn_contributors c WHERE c.retired_at IS NULL ORDER BY lower(c.name), c.created_at`, [issueId]);
  return people.map((p) => {
    const mine = pieces.filter((x) => pieceOwnerIds({ contributorId: x.contributor_id, sectionId: x.section_id }, sections).includes(p.id));
    const has = (s: string) => mine.some((x) => x.status === s);
    const state: ContributorState = !mine.length ? "none" : has("carried") ? "outstanding" : has("new") ? "new" : has("changed") ? "changed" : "confirmed";
    return {
      contributorId: p.id, name: p.name, state, pieces: mine.length, lastReminder: p.last ? new Date(p.last).toISOString() : null,
      hasEmail: !!String(p.email ?? "").trim(),
      ownsEvents: sections.some((s) => s.kind === "events" && !s.retired && s.ownerIds.includes(p.id)),
    };
  });
}

/** The issue reminders are about: the earliest one still collecting that hasn't gone out by date yet. */
export async function liveIssue(db: Db, today: string): Promise<Issue | null> {
  const { rows } = await db.query(
    `SELECT ${ISSUE_COLS} FROM gn_issues WHERE status = 'collecting' AND issue_date >= $1::date ORDER BY issue_date LIMIT 1`, [today]);
  return rows[0] ? issueRow(rows[0]) : null;
}

/** First date strictly after `today` that falls on weekday `sendDow` (0 = Sunday). */
export function nextIssueDate(today: string, sendDow: number): string {
  const delta = ((sendDow - weekdayOf(today) + 6) % 7) + 1;
  return addDays(today, delta);
}
