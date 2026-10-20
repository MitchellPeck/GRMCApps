// Content pipeline storage: events, content items and media assets. Every
// screen (both calendars, the board, event pages, the dashboard) is a filtered
// read over these three tables — nothing here keeps a second copy of a date or
// a status.
import { Pool, PoolClient, types } from "pg";
import { EVENT_COLORS, GAP_THRESHOLDS, DEFAULT_PLATFORMS, UPCOMING_DAYS } from "./config";
import { addDays } from "../dates";
import {
  ContentInput, ContentStatus, EventInput, Gap, MediaInput, MediaStatus, Result,
  checkStatusChange, computeGaps, lateMediaWarning, pipelineStatusToSeries, resolveMediaStatus,
  CONTENT_STATUSES,
} from "./rules";

// Hand `date` columns back as "YYYY-MM-DD" strings. pg's default turns them
// into a JS Date at local midnight — exactly the one-day drift these calendar
// dates exist to avoid. Set here rather than in db.ts so tests, which build
// their own Pool, get it too.
types.setTypeParser(types.builtins.DATE, (v) => v);

type Db = Pool | PoolClient;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface EventRow {
  id: string; name: string; kind: string; color: string;
  startDate: string | null; endDate: string | null; seriesId: string | null;
  ownerEmail: string; notes: string; archived: boolean;
  itemCount?: number;
}

export interface ContentRow {
  id: string; title: string; eventId: string | null; eventName: string; eventColor: string; eventKind: string;
  platforms: string[]; publishDate: string | null; publishTime: string | null; status: ContentStatus;
  ownerEmail: string; brief: string; caption: string; noMediaNeeded: boolean;
  seriesId: string | null; postIdx: number | null; draftId: number | null; draftKey: string;
  mediaTotal: number; mediaDone: number;
}

export interface MediaRow {
  id: string; contentItemId: string; description: string; type: string;
  gatherDate: string | null; gatherLocation: string; assigneeEmail: string; status: MediaStatus;
  fileLink: string; notes: string;
  itemTitle: string; itemPublishDate: string | null; itemStatus: ContentStatus;
  eventId: string | null; eventName: string; eventColor: string;
}

function eventOf(r: any): EventRow {
  const e: EventRow = {
    id: r.id, name: r.name, kind: r.kind, color: r.color,
    startDate: r.start_date, endDate: r.end_date, seriesId: r.series_id,
    ownerEmail: r.owner_email, notes: r.notes, archived: r.archived,
  };
  if (r.item_count != null) e.itemCount = Number(r.item_count);
  return e;
}

// "09:30:00" → "09:30", the shape <input type="time"> wants.
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

function contentOf(r: any): ContentRow {
  return {
    id: r.id, title: r.title, eventId: r.event_id,
    eventName: r.event_name || "", eventColor: r.event_color || "", eventKind: r.event_kind || "",
    platforms: r.platforms || [], publishDate: r.publish_date, publishTime: hhmm(r.publish_time),
    status: r.status, ownerEmail: r.owner_email, brief: r.brief, caption: r.caption,
    noMediaNeeded: r.no_media_needed, seriesId: r.series_id,
    postIdx: r.post_idx == null ? null : Number(r.post_idx),
    draftId: r.draft_id == null ? null : Number(r.draft_id), draftKey: r.draft_key,
    mediaTotal: Number(r.media_total || 0), mediaDone: Number(r.media_done || 0),
  };
}

function mediaOf(r: any): MediaRow {
  return {
    id: r.id, contentItemId: r.content_item_id, description: r.description, type: r.type,
    gatherDate: r.gather_date, gatherLocation: r.gather_location, assigneeEmail: r.assignee_email,
    status: r.status, fileLink: r.file_link, notes: r.notes,
    itemTitle: r.item_title || "", itemPublishDate: r.item_publish_date ?? null, itemStatus: r.item_status,
    eventId: r.event_id ?? null, eventName: r.event_name || "", eventColor: r.event_color || "",
  };
}

const CONTENT_SELECT = `
  SELECT ci.*, e.name AS event_name, e.color AS event_color, e.kind AS event_kind,
         COALESCE(m.total, 0) AS media_total, COALESCE(m.done, 0) AS media_done
    FROM content_items ci
    LEFT JOIN events e ON e.id = ci.event_id
    LEFT JOIN (
      SELECT content_item_id, count(*) AS total,
             count(*) FILTER (WHERE status IN ('captured','edited')) AS done
        FROM media_assets GROUP BY content_item_id
    ) m ON m.content_item_id = ci.id`;

const MEDIA_SELECT = `
  SELECT ma.*, ci.title AS item_title, ci.publish_date AS item_publish_date, ci.status AS item_status,
         e.id AS event_id, e.name AS event_name, e.color AS event_color
    FROM media_assets ma
    JOIN content_items ci ON ci.id = ma.content_item_id
    LEFT JOIN events e ON e.id = ci.event_id`;

// Builds "SET a = $1, b = $2" from a camelCase patch, skipping unknown keys.
function setClause(patch: Record<string, unknown>, columns: Record<string, string>, vals: unknown[]): string[] {
  const sets: string[] = [];
  for (const key of Object.keys(patch)) {
    const col = columns[key];
    if (!col) continue;
    vals.push(patch[key]);
    sets.push(`${col} = $${vals.length}`);
  }
  return sets;
}

// ── Events ───────────────────────────────────────────────────────────────────

const EVENT_COLUMNS: Record<string, string> = {
  name: "name", kind: "kind", color: "color", startDate: "start_date", endDate: "end_date",
  ownerEmail: "owner_email", notes: "notes", archived: "archived",
};

export async function nextEventColor(db: Db): Promise<string> {
  const r = await db.query("SELECT count(*) AS n FROM events");
  return EVENT_COLORS[Number(r.rows[0].n) % EVENT_COLORS.length];
}

export async function listEvents(db: Db, opts: { archived?: boolean } = {}): Promise<EventRow[]> {
  const where = opts.archived === undefined ? "" : "WHERE e.archived = $1";
  const r = await db.query(
    `SELECT e.*, (SELECT count(*) FROM content_items ci WHERE ci.event_id = e.id AND ci.status <> 'cancelled') AS item_count
       FROM events e ${where}
      ORDER BY e.archived, CASE e.kind WHEN 'event' THEN 0 WHEN 'series' THEN 1 ELSE 2 END,
               e.start_date NULLS LAST, lower(e.name)`,
    opts.archived === undefined ? [] : [opts.archived],
  );
  return r.rows.map(eventOf);
}

export async function createEvent(db: Db, input: EventInput): Promise<EventRow> {
  const color = input.color || (await nextEventColor(db));
  const r = await db.query(
    `INSERT INTO events (name, kind, color, start_date, end_date, owner_email, notes, archived)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.name, input.kind || "event", color, input.startDate ?? null, input.endDate ?? null,
     input.ownerEmail || "", input.notes || "", input.archived ?? false],
  );
  return eventOf(r.rows[0]);
}

export async function updateEvent(db: Db, id: string, input: EventInput): Promise<Result<EventRow>> {
  const vals: unknown[] = [];
  const sets = setClause(input as Record<string, unknown>, EVENT_COLUMNS, vals);
  if (sets.length) {
    vals.push(id);
    const r = await db.query(`UPDATE events SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
    if (!r.rowCount) return fail("Event not found.");
    const e = eventOf(r.rows[0]);
    // A date range is only checkable once both ends are known.
    if (e.startDate && e.endDate && e.endDate < e.startDate) {
      return fail("The end date is before the start date.");
    }
    return { ok: true, value: e };
  }
  const r = await db.query("SELECT * FROM events WHERE id = $1", [id]);
  return r.rowCount ? { ok: true, value: eventOf(r.rows[0]) } : fail("Event not found.");
}

// Deleting an event never deletes its posts: the FK clears their event_id.
export async function deleteEvent(db: Db, id: string): Promise<Result<true>> {
  const r = await db.query("DELETE FROM events WHERE id = $1", [id]);
  return r.rowCount ? { ok: true, value: true } : fail("Event not found.");
}

export async function getEvent(db: Db, id: string): Promise<Result<{ event: EventRow; items: ContentRow[]; media: MediaRow[] }>> {
  const e = await db.query("SELECT * FROM events WHERE id = $1", [id]);
  if (!e.rowCount) return fail("Event not found.");
  const items = await listContent(db, { eventId: id, includeCancelled: true });
  const media = await listMedia(db, { eventId: id });
  return { ok: true, value: { event: eventOf(e.rows[0]), items, media } };
}

// ── Content items ────────────────────────────────────────────────────────────

export interface ContentFilters {
  from?: string; to?: string; eventId?: string; platform?: string; statuses?: string[];
  ownerEmail?: string; ids?: string[]; undated?: boolean; includeCancelled?: boolean;
}

export async function listContent(db: Db, f: ContentFilters): Promise<ContentRow[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace("?", `$${vals.length}`)); };
  if (f.from) add("ci.publish_date >= ?", f.from);
  if (f.to) add("ci.publish_date <= ?", f.to);
  if (f.undated) where.push("ci.publish_date IS NULL");
  if (f.eventId) add("ci.event_id = ?", f.eventId);
  if (f.platform) add("? = ANY(ci.platforms)", f.platform);
  if (f.ownerEmail) add("lower(ci.owner_email) = lower(?)", f.ownerEmail);
  if (f.ids) add("ci.id = ANY(?)", f.ids);
  if (f.statuses && f.statuses.length) add("ci.status = ANY(?)", f.statuses);
  // Cancelled posts stay in history but off the calendars unless asked for.
  else if (!f.includeCancelled) where.push("ci.status <> 'cancelled'");
  const r = await db.query(
    `${CONTENT_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ci.publish_date NULLS LAST, ci.publish_time NULLS LAST, ci.created_at`,
    vals,
  );
  return r.rows.map(contentOf);
}

export async function getContentRow(db: Db, id: string): Promise<ContentRow | null> {
  const r = await db.query(`${CONTENT_SELECT} WHERE ci.id = $1`, [id]);
  return r.rowCount ? contentOf(r.rows[0]) : null;
}

export interface ContentDetail {
  item: ContentRow; media: MediaRow[];
  /** Where the caption came from, when the automated drafting wrote it. */
  source: { kind: "series"; seriesName: string; postNumber: number } | { kind: "run"; run: string; key: string; draftedAt: string } | null;
}

export async function getContent(db: Db, id: string): Promise<Result<ContentDetail>> {
  const item = await getContentRow(db, id);
  if (!item) return fail("Post not found.");
  const media = await listMedia(db, { contentItemId: id });
  let source: ContentDetail["source"] = null;
  if (item.seriesId != null && item.postIdx != null) {
    const s = await db.query("SELECT name FROM series WHERE id = $1", [item.seriesId]);
    if (s.rowCount) source = { kind: "series", seriesName: s.rows[0].name, postNumber: item.postIdx + 1 };
  } else if (item.draftId != null) {
    const d = await db.query("SELECT run, key, created_at FROM post_drafts WHERE id = $1", [item.draftId]);
    if (d.rowCount) source = { kind: "run", run: d.rows[0].run, key: d.rows[0].key, draftedAt: String(d.rows[0].created_at) };
  }
  return { ok: true, value: { item, media, source } };
}

const CONTENT_COLUMNS: Record<string, string> = {
  title: "title", eventId: "event_id", platforms: "platforms", publishDate: "publish_date",
  publishTime: "publish_time", status: "status", ownerEmail: "owner_email", brief: "brief",
  caption: "caption", noMediaNeeded: "no_media_needed",
};

async function eventExists(db: Db, id: string | null | undefined): Promise<boolean> {
  if (!id) return true;
  const r = await db.query("SELECT 1 FROM events WHERE id = $1", [id]);
  return !!r.rowCount;
}

export async function createContent(db: Db, input: ContentInput, createdBy: string): Promise<Result<ContentRow>> {
  if (!(await eventExists(db, input.eventId))) return fail("That event no longer exists.");
  const status = input.status || (input.caption ? "drafted" : input.brief ? "planned" : "idea");
  // A brand-new post has no media, so the Ready gate applies to its first status too.
  const gate = checkStatusChange(status, { noMediaNeeded: !!input.noMediaNeeded }, []);
  if (!gate.ok) return gate;
  const r = await db.query(
    `INSERT INTO content_items (title, event_id, platforms, publish_date, publish_time, status, owner_email,
                                brief, caption, no_media_needed, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [input.title, input.eventId ?? null, input.platforms ?? DEFAULT_PLATFORMS, input.publishDate ?? null,
     input.publishTime ?? null, status, input.ownerEmail || "", input.brief || "", input.caption || "",
     !!input.noMediaNeeded, createdBy],
  );
  return { ok: true, value: (await getContentRow(db, r.rows[0].id))! };
}

export async function updateContent(
  db: Db, id: string, input: ContentInput,
): Promise<Result<{ item: ContentRow; warnings: string[] }>> {
  const current = await getContentRow(db, id);
  if (!current) return fail("Post not found.");
  if ("eventId" in input && !(await eventExists(db, input.eventId))) return fail("That event no longer exists.");

  const media = await listMedia(db, { contentItemId: id });
  if (input.status && input.status !== current.status) {
    const noMediaNeeded = input.noMediaNeeded ?? current.noMediaNeeded;
    const gate = checkStatusChange(input.status, { noMediaNeeded }, media);
    if (!gate.ok) return gate;
  }

  const vals: unknown[] = [];
  const sets = setClause(input as Record<string, unknown>, CONTENT_COLUMNS, vals);
  if (sets.length) {
    vals.push(id);
    await db.query(`UPDATE content_items SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
  }
  const item = (await getContentRow(db, id))!;
  await writeBackToSeries(db, item);

  const warnings = media
    .filter((m) => lateMediaWarning(m.gatherDate, item.publishDate))
    .map((m) => `${m.description}: ${lateMediaWarning(m.gatherDate, item.publishDate)}`);
  return { ok: true, value: { item, warnings } };
}

// The Series tab reads a linked post's status and draft from its content item,
// but the legacy columns are kept current too so rolling back to an image
// without the pipeline loses nothing.
export async function writeBackToSeries(db: Db, item: ContentRow): Promise<void> {
  if (item.seriesId == null || item.postIdx == null) return;
  await db.query(
    `UPDATE series_posts SET status = $1, draft = $2, title = $3, sub = $4
      WHERE series_id = $5 AND post_idx = $6`,
    [pipelineStatusToSeries(item.status), item.caption, item.title, item.brief, item.seriesId, item.postIdx],
  );
}

export async function deleteContent(db: Db, id: string): Promise<Result<{ mediaDeleted: number }>> {
  const m = await db.query("SELECT count(*) AS n FROM media_assets WHERE content_item_id = $1", [id]);
  const r = await db.query("DELETE FROM content_items WHERE id = $1", [id]);
  if (!r.rowCount) return fail("Post not found.");
  return { ok: true, value: { mediaDeleted: Number(m.rows[0].n) } };
}

// ── Media assets ─────────────────────────────────────────────────────────────

export interface MediaFilters {
  from?: string; to?: string; eventId?: string; assigneeEmail?: string; statuses?: string[];
  unscheduled?: boolean; contentItemId?: string; ids?: string[]; includeCancelled?: boolean;
}

export async function listMedia(db: Db, f: MediaFilters): Promise<MediaRow[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace("?", `$${vals.length}`)); };
  if (f.from) add("ma.gather_date >= ?", f.from);
  if (f.to) add("ma.gather_date <= ?", f.to);
  if (f.unscheduled) where.push("ma.gather_date IS NULL");
  if (f.eventId) add("ci.event_id = ?", f.eventId);
  if (f.assigneeEmail) add("lower(ma.assignee_email) = lower(?)", f.assigneeEmail);
  if (f.statuses && f.statuses.length) add("ma.status = ANY(?)", f.statuses);
  if (f.contentItemId) add("ma.content_item_id = ?", f.contentItemId);
  if (f.ids) add("ma.id = ANY(?)", f.ids);
  if (!f.includeCancelled && !f.contentItemId && !f.eventId) where.push("ci.status <> 'cancelled'");
  const r = await db.query(
    `${MEDIA_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ma.gather_date NULLS LAST, ci.publish_date NULLS LAST, ma.created_at`,
    vals,
  );
  return r.rows.map(mediaOf);
}

async function getMediaRow(db: Db, id: string): Promise<MediaRow | null> {
  const r = await db.query(`${MEDIA_SELECT} WHERE ma.id = $1`, [id]);
  return r.rowCount ? mediaOf(r.rows[0]) : null;
}

const MEDIA_COLUMNS: Record<string, string> = {
  description: "description", type: "type", gatherDate: "gather_date", gatherLocation: "gather_location",
  assigneeEmail: "assignee_email", status: "status", fileLink: "file_link", notes: "notes",
};

export async function createMedia(
  db: Db, contentItemId: string, input: MediaInput,
): Promise<Result<{ media: MediaRow; warnings: string[] }>> {
  const item = await getContentRow(db, contentItemId);
  if (!item) return fail("Post not found.");
  const status = resolveMediaStatus({ status: "needed", gatherDate: null }, input);
  if (!status.ok) return status;
  const r = await db.query(
    `INSERT INTO media_assets (content_item_id, description, type, gather_date, gather_location,
                               assignee_email, status, file_link, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [contentItemId, input.description, input.type || "photo", input.gatherDate ?? null,
     input.gatherLocation || "", input.assigneeEmail || "", status.value, input.fileLink || "", input.notes || ""],
  );
  const media = (await getMediaRow(db, r.rows[0].id))!;
  const w = lateMediaWarning(media.gatherDate, media.itemPublishDate);
  return { ok: true, value: { media, warnings: w ? [w] : [] } };
}

export async function updateMedia(
  db: Db, id: string, input: MediaInput,
): Promise<Result<{ media: MediaRow; warnings: string[] }>> {
  const current = await getMediaRow(db, id);
  if (!current) return fail("Media not found.");
  const status = resolveMediaStatus(current, input);
  if (!status.ok) return status;
  const patch: Record<string, unknown> = { ...input, status: status.value };
  const vals: unknown[] = [];
  const sets = setClause(patch, MEDIA_COLUMNS, vals);
  vals.push(id);
  await db.query(`UPDATE media_assets SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
  const media = (await getMediaRow(db, id))!;
  const w = lateMediaWarning(media.gatherDate, media.itemPublishDate);
  return { ok: true, value: { media, warnings: w ? [w] : [] } };
}

export async function deleteMedia(db: Db, id: string): Promise<Result<true>> {
  const r = await db.query("DELETE FROM media_assets WHERE id = $1", [id]);
  return r.rowCount ? { ok: true, value: true } : fail("Media not found.");
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export async function dashboardSummary(db: Db, today: string) {
  const until = addDays(today, UPCOMING_DAYS - 1);
  const counts = await db.query("SELECT status, count(*) AS n FROM content_items GROUP BY status");
  const byStatus: Record<string, number> = {};
  for (const s of CONTENT_STATUSES) byStatus[s] = 0;
  for (const r of counts.rows) byStatus[r.status] = Number(r.n);
  const posts = await listContent(db, { from: today, to: until });
  const capture = await listMedia(db, { from: today, to: until });
  const upcomingEvents = (await db.query(
    `SELECT * FROM events
      WHERE NOT archived AND kind = 'event' AND COALESCE(end_date, start_date) >= $1
      ORDER BY start_date NULLS LAST LIMIT 8`,
    [today],
  )).rows.map(eventOf);
  return { today, until, byStatus, posts, capture, upcomingEvents };
}

export async function dashboardGaps(db: Db, today: string): Promise<{ today: string; gaps: Gap[] }> {
  const items = (await listContent(db, {})).map((i) => ({
    id: i.id, publishDate: i.publishDate, status: i.status, noMediaNeeded: i.noMediaNeeded, mediaCount: i.mediaTotal,
  }));
  const media = (await listMedia(db, {})).map((m) => ({
    id: m.id, contentItemId: m.contentItemId, gatherDate: m.gatherDate, status: m.status,
    itemPublishDate: m.itemPublishDate, itemStatus: m.itemStatus,
  }));
  return { today, gaps: computeGaps(items, media, today, GAP_THRESHOLDS) };
}
