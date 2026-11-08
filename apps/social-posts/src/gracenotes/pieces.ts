// Grace Notes piece actions: contributors and the admin confirm, edit, drop and add pieces.
// Dated items are shared with the social side's `events` table and flagged there for the admin.
import { Pool, PoolClient } from "pg";
import { Result, isIsoDate } from "../pipeline/rules";
import { createEvent, updateEvent } from "../pipeline/repo";
import { getIssue, currentIssue, pieceHash, pieceOwnerIds } from "./issues";
import { sanitizeHtml } from "./html";
import { listSections, withTx } from "./repo";
import { Contributor, Details, Piece, Section } from "./types";

type Db = Pool | PoolClient;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export type Actor = { kind: "contributor"; contributor: Contributor } | { kind: "admin"; email: string };
export interface PieceInput {
  title?: string; bodyHtml?: string; details?: Details; imageUrl?: string;
  startDate?: string; endDate?: string | null;
}

const NOT_YOURS = "That piece isn't yours.";
const BAD_DATE = "Use a real date like 2026-11-19.";

const PIECE_SQL = `
  SELECT p.id, p.issue_id, p.section_id, p.contributor_id, p.event_id, p.title, p.body_html, p.details, p.image_url,
         p.status, p.position, p.carried_from, p.content_hash, p.updated_by, p.updated_at,
         s.title AS section_title, s.kind AS section_kind,
         e.name AS event_name, to_char(e.start_date,'YYYY-MM-DD') AS event_start_date, e.image_url AS event_image_url
    FROM gn_pieces p
    JOIN gn_sections s ON s.id = p.section_id
    LEFT JOIN events e ON e.id = p.event_id`;

function pieceRow(r: Record<string, any>): Piece {
  return {
    id: r.id, issueId: r.issue_id, sectionId: r.section_id, contributorId: r.contributor_id, eventId: r.event_id,
    title: r.title, bodyHtml: r.body_html, details: r.details ?? {}, imageUrl: r.image_url,
    status: r.status, position: Number(r.position), carriedFrom: r.carried_from, contentHash: r.content_hash,
    updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString(),
    sectionTitle: r.section_title, sectionKind: r.section_kind,
    eventName: r.event_name ?? null, eventStartDate: r.event_start_date ?? null, eventImageUrl: r.event_image_url ?? null,
  };
}

export async function getPiece(db: Db, id: string): Promise<Piece | null> {
  const { rows } = await db.query(`${PIECE_SQL} WHERE p.id = $1`, [id]);
  return rows[0] ? pieceRow(rows[0]) : null;
}

export async function listPieces(db: Db, issueId: string): Promise<Piece[]> {
  const { rows } = await db.query(`${PIECE_SQL} WHERE p.issue_id = $1 ORDER BY s.position, p.position, p.updated_at, p.id`, [issueId]);
  return rows.map(pieceRow);
}

export function effectiveImage(piece: Piece): string {
  return piece.eventId && piece.eventImageUrl ? piece.eventImageUrl : piece.imageUrl;
}

export function canTouch(piece: Piece, actor: Actor, sections: Section[]): boolean {
  if (actor.kind === "admin") return true;
  return pieceOwnerIds(piece, sections).includes(actor.contributor.id);
}

const actorName = (a: Actor) => (a.kind === "admin" ? a.email : a.contributor.name);

/** Load a piece and check the actor may touch it. */
async function guarded(db: Db, pieceId: string, actor: Actor): Promise<Result<Piece>> {
  const piece = await getPiece(db, pieceId);
  if (!piece) return fail("Piece not found.");
  const sections = await listSections(db, { includeRetired: true });
  if (!canTouch(piece, actor, sections)) return fail(NOT_YOURS);
  return { ok: true, value: piece };
}

async function must(db: Db, id: string): Promise<Piece> {
  const p = await getPiece(db, id);
  if (!p) throw new Error("Piece vanished.");
  return p;
}

function checkDates(input: PieceInput): string | null {
  if (input.startDate !== undefined && !isIsoDate(input.startDate)) return BAD_DATE;
  if (input.endDate !== undefined && input.endDate !== null && input.endDate !== "" && !isIsoDate(input.endDate)) return BAD_DATE;
  return null;
}

function cleanBody(html: string): Result<string> {
  try { return { ok: true, value: sanitizeHtml(html) }; }
  catch (e) { return fail(e instanceof Error ? e.message : "That text couldn't be saved."); }
}

/** Make an events row for a dated item and flag it for the admin when a contributor made it. */
async function makeEvent(db: Db, title: string, start: string, end: string | null, imageUrl: string, actor: Actor): Promise<string> {
  const ev = await createEvent(db, {
    name: title, kind: "event", startDate: start, endDate: end,
    ownerEmail: actor.kind === "admin" ? actor.email : actor.contributor.email,
  });
  await db.query("UPDATE events SET image_url = $2, review_note = $3 WHERE id = $1",
    [ev.id, imageUrl, actor.kind === "contributor" ? `New from ${actor.contributor.name}` : ""]);
  return ev.id;
}

export async function confirmPiece(db: Db, pieceId: string, actor: Actor): Promise<Result<Piece>> {
  const g = await guarded(db, pieceId, actor);
  if (!g.ok) return g;
  if (g.value.status === "dropped") return fail("That piece was dropped.");
  // A new or changed piece keeps saying so; only a carried one becomes "confirmed".
  await db.query(
    `UPDATE gn_pieces SET status = CASE WHEN status = 'carried' THEN 'confirmed' ELSE status END,
            updated_by = $2, updated_at = now() WHERE id = $1`, [pieceId, actorName(actor)]);
  return { ok: true, value: await must(db, pieceId) };
}

export async function editPiece(db: Db, pieceId: string, input: PieceInput, actor: Actor): Promise<Result<Piece>> {
  const g = await guarded(db, pieceId, actor);
  if (!g.ok) return g;
  const cur = g.value;
  if (cur.status === "dropped") return fail("That piece was dropped.");
  const dateErr = checkDates(input);
  if (dateErr) return fail(dateErr);

  const title = input.title ?? cur.title;
  let bodyHtml = cur.bodyHtml;
  if (input.bodyHtml !== undefined) {
    const b = cleanBody(input.bodyHtml);
    if (!b.ok) return b;
    bodyHtml = b.value;
  }
  const details: Details = { ...(input.details ?? cur.details) };
  const imageUrl = input.imageUrl ?? cur.imageUrl;
  const endDate = input.endDate === undefined ? undefined : input.endDate || null;

  if (cur.eventId) {
    const ev = (await db.query("SELECT to_char(start_date,'YYYY-MM-DD') s, to_char(end_date,'YYYY-MM-DD') e FROM events WHERE id = $1", [cur.eventId])).rows[0];
    const s = input.startDate ?? ev?.s ?? null;
    const e = endDate === undefined ? ev?.e ?? null : endDate;
    if (s && e && e < s) return fail("The end date is before the start date.");
  } else if (input.startDate && endDate && endDate < input.startDate) {
    return fail("The end date is before the start date.");
  }

  return withTx(db, async (c): Promise<Result<Piece>> => {
    let eventId = cur.eventId;
    if (eventId) {
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.name = title;
      if (input.startDate !== undefined) patch.startDate = input.startDate;
      if (endDate !== undefined) patch.endDate = endDate;
      const u = await updateEvent(c, eventId, patch);
      if (!u.ok) throw new Error(u.error);
      if (input.imageUrl !== undefined) await c.query("UPDATE events SET image_url = $2 WHERE id = $1", [eventId, imageUrl]);
    } else if (cur.sectionKind === "events" && input.startDate) {
      // R3: giving an unlinked item a date shares it as an event, like addItem does.
      eventId = await makeEvent(c, title, input.startDate, endDate ?? null, imageUrl, actor);
    } else if (endDate !== undefined) {
      if (endDate) details.endDate = endDate; else delete details.endDate;
    }

    const hash = pieceHash({ title, bodyHtml, details, imageUrl, eventId });
    let status = cur.status;
    if (cur.status !== "new") {
      const src = cur.carriedFrom ? await getPiece(c, cur.carriedFrom) : null;
      status = src && pieceHash(src) === hash ? "confirmed" : "changed";
    }
    await c.query(
      `UPDATE gn_pieces SET title=$2, body_html=$3, details=$4, image_url=$5, event_id=$6, status=$7,
              content_hash=$8, updated_by=$9, updated_at=now() WHERE id=$1`,
      [pieceId, title, bodyHtml, JSON.stringify(details), imageUrl, eventId, status, hash, actorName(actor)]);
    if (cur.eventId && status === "changed" && actor.kind === "contributor") {
      await c.query("UPDATE events SET review_note = $2 WHERE id = $1", [cur.eventId, `Changed by ${actor.contributor.name}`]);
    }
    return { ok: true, value: await must(c, pieceId) };
  }).catch((e) => {
    if (e instanceof Error && /end date/i.test(e.message)) return fail(e.message);
    throw e;
  });
}

export async function dropPiece(db: Db, pieceId: string, actor: Actor): Promise<Result<Piece>> {
  const g = await guarded(db, pieceId, actor);
  if (!g.ok) return g;
  if (g.value.sectionKind !== "events") return fail("Text sections can't be dropped; clear the text instead.");
  await db.query("UPDATE gn_pieces SET status = 'dropped', updated_by = $2, updated_at = now() WHERE id = $1", [pieceId, actorName(actor)]);
  return { ok: true, value: await must(db, pieceId) };
}

export async function addItem(db: Db, issueId: string, sectionId: string, input: PieceInput, actor: Actor): Promise<Result<Piece>> {
  const issue = await getIssue(db, issueId);
  if (!issue) return fail("Issue not found.");
  const section = (await listSections(db)).find((s) => s.id === sectionId);
  if (!section || section.kind !== "events") return fail("Items can only be added to an events section.");
  const title = (input.title ?? "").trim();
  if (!title) return fail("Give the item a title.");
  const dateErr = checkDates(input);
  if (dateErr) return fail(dateErr);
  const endDate = input.endDate || null;
  if (input.startDate && endDate && endDate < input.startDate) return fail("The end date is before the start date.");
  let bodyHtml = "";
  if (input.bodyHtml) {
    const b = cleanBody(input.bodyHtml);
    if (!b.ok) return b;
    bodyHtml = b.value;
  }
  const details: Details = { ...(input.details ?? {}) };
  if (!input.startDate && endDate) details.endDate = endDate;
  const imageUrl = input.imageUrl ?? "";

  return withTx(db, async (c): Promise<Result<Piece>> => {
    const eventId = input.startDate ? await makeEvent(c, title, input.startDate, endDate, imageUrl, actor) : null;
    const pos = await c.query("SELECT COALESCE(max(position), -1) + 1 AS n FROM gn_pieces WHERE issue_id = $1 AND section_id = $2", [issueId, sectionId]);
    const hash = pieceHash({ title, bodyHtml, details, imageUrl, eventId });
    const ins = await c.query(
      `INSERT INTO gn_pieces (issue_id, section_id, contributor_id, event_id, title, body_html, details, image_url,
                              status, position, content_hash, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'new',$9,$10,$11) RETURNING id`,
      [issueId, sectionId, actor.kind === "contributor" ? actor.contributor.id : null, eventId, title, bodyHtml,
       JSON.stringify(details), imageUrl, pos.rows[0].n, hash, actorName(actor)]);
    return { ok: true, value: await must(c, ins.rows[0].id) };
  });
}

/** Admin only: point a piece at an existing event. */
export async function linkEvent(db: Db, pieceId: string, eventId: string): Promise<Result<Piece>> {
  const piece = await getPiece(db, pieceId);
  if (!piece) return fail("Piece not found.");
  const ev = await db.query("SELECT 1 FROM events WHERE id = $1", [eventId]);
  if (!ev.rowCount) return fail("Event not found.");
  const hash = pieceHash({ ...piece, eventId });
  await db.query("UPDATE gn_pieces SET event_id = $2, content_hash = $3, updated_at = now() WHERE id = $1", [pieceId, eventId, hash]);
  return { ok: true, value: await must(db, pieceId) };
}

export interface ContributorView {
  issue: { id: string; issueDate: string } | null;
  pieces: Piece[];
  sections: Array<{ id: string; title: string; kind: string }>;
  history: Array<{ issueDate: string; title: string; sectionTitle: string; bodyHtml: string; details: Details; imageUrl: string }>;
}

/** Everything a contributor's page shows. Never includes another contributor's data or any token. */
export async function contributorView(db: Db, contributor: Contributor): Promise<ContributorView> {
  const sections = await listSections(db);
  const issue = await currentIssue(db);
  const mine = (p: { contributorId: string | null; sectionId: string }) => pieceOwnerIds(p, sections).includes(contributor.id);
  const pieces = issue
    ? (await listPieces(db, issue.id)).filter((p) => p.status !== "dropped" && mine(p)).map((p) => ({ ...p, updatedBy: "" }))
    : [];
  const visible = sections
    .filter((s) => s.kind === "events" || s.ownerIds.includes(contributor.id))
    .map((s) => ({ id: s.id, title: s.title, kind: s.kind }));

  const { rows } = await db.query(
    `SELECT to_char(i.issue_date,'YYYY-MM-DD') AS issue_date, p.title, s.title AS section_title, p.body_html, p.details, p.image_url,
            p.section_id, p.contributor_id
       FROM gn_pieces p
       JOIN gn_issues i ON i.id = p.issue_id
       JOIN gn_sections s ON s.id = p.section_id
      WHERE p.status <> 'dropped' AND (p.title <> '' OR p.body_html <> '')
        AND ($1::date IS NULL OR i.issue_date < $1::date)
      ORDER BY i.issue_date DESC, p.position, p.id`,
    [issue?.issueDate ?? null]);
  const seen = new Set<string>();
  const history: ContributorView["history"] = [];
  for (const r of rows) {
    if (history.length >= 30) break;
    if (!mine({ contributorId: r.contributor_id, sectionId: r.section_id })) continue;
    // A piece carried unchanged week after week appears once, at its newest.
    const key = JSON.stringify([r.section_id, r.title, r.body_html, r.details, r.image_url]);
    if (seen.has(key)) continue;
    seen.add(key);
    history.push({ issueDate: r.issue_date, title: r.title, sectionTitle: r.section_title, bodyHtml: r.body_html, details: r.details ?? {}, imageUrl: r.image_url });
  }
  return { issue: issue ? { id: issue.id, issueDate: issue.issueDate } : null, pieces, sections: visible, history };
}
