// Recurring posts in the database: templates, the generator that keeps their
// upcoming occurrences on the calendar as real content items, and how
// series-wide edits reach those items without trampling ones someone has
// already worked on.
import { Pool, PoolClient } from "pg";
import { addDays } from "../dates";
import { DEFAULT_PLATFORMS, RUN_EVENTS } from "./config";
import { MediaTemplateItem, RecurrenceInput, Rule, describeRule, occurrences } from "./recurrence";
import { Result } from "./rules";

type Db = Pool | PoolClient;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** How far ahead occurrences exist as real posts. The calendar asks for more on demand. */
export const HORIZON_DAYS = 56;
/** Never generate further out than this, whatever a caller asks for. */
const MAX_AHEAD_DAYS = 400;

/** Occurrences nobody has touched yet: still only a slot on the calendar. */
const UNTOUCHED = ["idea", "planned"];

export interface RecurrenceRow {
  id: string; title: string; brief: string; eventId: string | null; eventName: string; eventColor: string;
  platforms: string[]; publishTime: string | null; ownerEmail: string; noMediaNeeded: boolean;
  mediaTemplate: MediaTemplateItem[]; draftKey: string; active: boolean;
  rule: Rule; summary: string; nextDates: string[];
}

function ruleOf(r: any): Rule {
  return {
    freq: r.freq, interval: r.every, weekdays: r.weekdays || [], monthDay: r.month_day, nth: r.nth,
    weekday: r.weekday, startDate: r.start_date, endDate: r.end_date, count: r.max_count,
  };
}

function recurrenceOf(r: any, today: string): RecurrenceRow {
  const rule = ruleOf(r);
  return {
    id: r.id, title: r.title, brief: r.brief, eventId: r.event_id,
    eventName: r.event_name || "", eventColor: r.event_color || "",
    platforms: r.platforms || [], publishTime: r.publish_time ? String(r.publish_time).slice(0, 5) : null,
    ownerEmail: r.owner_email, noMediaNeeded: r.no_media_needed, mediaTemplate: r.media_template || [],
    draftKey: r.draft_key, active: r.active, rule, summary: describeRule(rule),
    nextDates: r.active ? occurrences(rule, addDays(today, 366)).filter((d) => d >= today).slice(0, 4) : [],
  };
}

const SELECT = `SELECT r.*, e.name AS event_name, e.color AS event_color
                  FROM recurrences r LEFT JOIN events e ON e.id = r.event_id`;

export async function listRecurrences(db: Db, today: string): Promise<RecurrenceRow[]> {
  const r = await db.query(`${SELECT} ORDER BY NOT r.active, lower(r.title)`);
  return r.rows.map((row) => recurrenceOf(row, today));
}

export async function getRecurrence(db: Db, id: string, today: string): Promise<RecurrenceRow | null> {
  const r = await db.query(`${SELECT} WHERE r.id = $1`, [id]);
  return r.rowCount ? recurrenceOf(r.rows[0], today) : null;
}

// camelCase template field → recurrences column → content_items column.
const TEMPLATE_FIELDS: Array<[keyof RecurrenceInput, string, string]> = [
  ["title", "title", "title"], ["brief", "brief", "brief"], ["eventId", "event_id", "event_id"],
  ["platforms", "platforms", "platforms"], ["publishTime", "publish_time", "publish_time"],
  ["ownerEmail", "owner_email", "owner_email"], ["noMediaNeeded", "no_media_needed", "no_media_needed"],
];

function ruleColumns(rule: Rule): Record<string, unknown> {
  return {
    freq: rule.freq, every: rule.interval, weekdays: rule.weekdays, month_day: rule.monthDay, nth: rule.nth,
    weekday: rule.weekday, start_date: rule.startDate, end_date: rule.endDate, max_count: rule.count,
  };
}

async function eventExists(db: Db, id: string | null | undefined): Promise<boolean> {
  if (!id) return true;
  return !!(await db.query("SELECT 1 FROM events WHERE id = $1", [id])).rowCount;
}

export async function createRecurrence(
  db: Db, input: RecurrenceInput, createdBy: string, today: string, draftKey = "",
): Promise<Result<RecurrenceRow>> {
  if (!(await eventExists(db, input.eventId))) return fail("That event no longer exists.");
  const cols: Record<string, unknown> = {
    title: input.title, brief: input.brief || "", event_id: input.eventId ?? null,
    platforms: input.platforms ?? DEFAULT_PLATFORMS, publish_time: input.publishTime ?? null,
    owner_email: input.ownerEmail || "", no_media_needed: !!input.noMediaNeeded,
    media_template: JSON.stringify(input.mediaTemplate || []), draft_key: draftKey,
    active: input.active ?? true, created_by: createdBy, ...ruleColumns(input.rule!),
  };
  const keys = Object.keys(cols);
  const r = await db.query(
    `INSERT INTO recurrences (${keys.join(", ")}) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(", ")}) RETURNING id`,
    keys.map((k) => cols[k]),
  );
  const id = r.rows[0].id;
  await materialize(db, today, addDays(today, HORIZON_DAYS), id);
  return { ok: true, value: (await getRecurrence(db, id, today))! };
}

/**
 * Edit a recurrence. Template changes reach every future occurrence nobody has
 * worked on yet; a rule change also drops untouched occurrences that no longer
 * fall on a repeat date and generates the new ones.
 */
export async function updateRecurrence(
  db: Db, id: string, input: RecurrenceInput, today: string,
): Promise<Result<RecurrenceRow>> {
  const current = await getRecurrence(db, id, today);
  if (!current) return fail("Recurring post not found.");
  if ("eventId" in input && !(await eventExists(db, input.eventId))) return fail("That event no longer exists.");

  const cols: Record<string, unknown> = {};
  for (const [key, col] of TEMPLATE_FIELDS) if (key in input) cols[col] = input[key];
  if (input.mediaTemplate) cols.media_template = JSON.stringify(input.mediaTemplate);
  if ("active" in input) cols.active = input.active;
  if (input.rule) Object.assign(cols, ruleColumns(input.rule));
  const keys = Object.keys(cols);
  if (keys.length) {
    await db.query(
      `UPDATE recurrences SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = now() WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => cols[k]), id],
    );
  }

  await propagate(db, id, today, input);
  if (input.mediaTemplate) await refreshTemplateMedia(db, id, today, input.mediaTemplate);

  // A paused recurrence, or a changed rule, leaves untouched future slots that
  // no longer belong on the calendar.
  const updated = (await getRecurrence(db, id, today))!;
  const keep = updated.active ? new Set(occurrences(updated.rule, addDays(today, MAX_AHEAD_DAYS))) : new Set<string>();
  const future = await db.query(
    `SELECT id, occurrence_date FROM content_items
      WHERE recurrence_id = $1 AND occurrence_date >= $2 AND NOT detached AND status = ANY($3)`,
    [id, today, UNTOUCHED],
  );
  const drop = future.rows.filter((r) => !keep.has(r.occurrence_date)).map((r) => r.id);
  if (drop.length) await db.query("DELETE FROM content_items WHERE id = ANY($1)", [drop]);

  await materialize(db, today, addDays(today, HORIZON_DAYS), id);
  return { ok: true, value: (await getRecurrence(db, id, today))! };
}

/** Copy template fields onto future untouched occurrences, from `fromDate` on. */
export async function propagate(db: Db, id: string, fromDate: string, input: RecurrenceInput, exceptItemId?: string): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, , itemCol] of TEMPLATE_FIELDS) {
    if (!(key in input)) continue;
    vals.push(input[key]);
    sets.push(`${itemCol} = $${vals.length}`);
  }
  if (!sets.length) return;
  vals.push(id, fromDate, UNTOUCHED, exceptItemId ?? "");
  const n = vals.length;
  await db.query(
    `UPDATE content_items SET ${sets.join(", ")}, updated_at = now()
      WHERE recurrence_id = $${n - 3} AND occurrence_date >= $${n - 2} AND NOT detached
        AND status = ANY($${n - 1}) AND id <> $${n}`,
    vals,
  );
}

/**
 * Swap the template media on future untouched occurrences for the new list.
 * Media someone added by hand, or has started capturing, stays.
 */
async function refreshTemplateMedia(db: Db, id: string, today: string, template: MediaTemplateItem[]): Promise<void> {
  const items = await db.query(
    `SELECT id, occurrence_date FROM content_items
      WHERE recurrence_id = $1 AND occurrence_date >= $2 AND NOT detached AND status = ANY($3)`,
    [id, today, UNTOUCHED],
  );
  for (const it of items.rows) {
    await db.query(
      `DELETE FROM media_assets WHERE content_item_id = $1 AND from_template AND status IN ('needed','scheduled')`,
      [it.id],
    );
    await insertTemplateMedia(db, it.id, it.occurrence_date, template);
  }
}

async function insertTemplateMedia(db: Db, itemId: string, date: string, template: MediaTemplateItem[]): Promise<void> {
  for (const m of template) {
    const gather = addDays(date, m.offsetDays || 0);
    await db.query(
      `INSERT INTO media_assets (content_item_id, description, type, gather_date, assignee_email, status, from_template)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [itemId, m.description, m.type, gather, m.assigneeEmail || "", "scheduled"],
    );
  }
}

/**
 * End a recurrence: its untouched future occurrences go, everything already
 * worked on or in the past stays as ordinary posts.
 */
export async function deleteRecurrence(db: Db, id: string, today: string): Promise<Result<{ removed: number }>> {
  const r = await db.query(
    `DELETE FROM content_items
      WHERE recurrence_id = $1 AND occurrence_date >= $2 AND NOT detached AND status = ANY($3)`,
    [id, today, UNTOUCHED],
  );
  const d = await db.query("DELETE FROM recurrences WHERE id = $1", [id]);
  if (!d.rowCount) return fail("Recurring post not found.");
  return { ok: true, value: { removed: r.rowCount || 0 } };
}

/**
 * Make sure every active recurrence's occurrences between today and `until`
 * exist as content items. Idempotent: the (recurrence, date) index means a
 * slot is only ever created once, and a skipped (cancelled) slot stays
 * skipped. Past dates are never filled in.
 */
export async function materialize(db: Db, today: string, until: string, onlyId?: string): Promise<number> {
  const cap = addDays(today, MAX_AHEAD_DAYS);
  const to = until > cap ? cap : until;
  const recs = await db.query(
    `SELECT * FROM recurrences WHERE active ${onlyId ? "AND id = $1" : ""}`,
    onlyId ? [onlyId] : [],
  );
  let created = 0;
  for (const rec of recs.rows) {
    const rule = ruleOf(rec);
    for (const date of occurrences(rule, to)) {
      if (date < today) continue;
      // A weekly run may already have drafted this slot before it was a
      // recurrence; don't put an empty twin beside it.
      if (rec.draft_key && rec.event_id) {
        const twin = await db.query(
          `SELECT 1 FROM content_items WHERE event_id = $1 AND draft_key = $2 AND publish_date = $3
             AND (recurrence_id IS NULL OR recurrence_id <> $4)`,
          [rec.event_id, rec.draft_key, date, rec.id],
        );
        if (twin.rowCount) continue;
      }
      const r = await db.query(
        `INSERT INTO content_items (title, event_id, platforms, publish_date, publish_time, status, owner_email, brief,
                                    no_media_needed, draft_key, recurrence_id, occurrence_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$4,'recurrence')
         ON CONFLICT (recurrence_id, occurrence_date) DO NOTHING RETURNING id`,
        [rec.title, rec.event_id, rec.platforms, date, rec.publish_time, rec.brief ? "planned" : "idea",
         rec.owner_email, rec.brief, rec.no_media_needed, rec.draft_key, rec.id],
      );
      if (!r.rowCount) continue;
      created++;
      await insertTemplateMedia(db, r.rows[0].id, date, rec.media_template || []);
    }
  }
  return created;
}

export const RUN_RECURRENCES_SETTING = "pipeline_run_recurrences_v1";

/**
 * The weekly runs become recurrences, once, so their slots sit on the
 * calendar weeks ahead and each run fills its own slot when it drafts.
 */
export async function seedRunRecurrences(db: Db, today: string): Promise<number> {
  const seeds: Array<{ run: string; key: string; title: string; weekday: number }> = [
    { run: "wednesday", key: "wednesday", title: "Grace Notes", weekday: 3 },
    { run: "wednesday", key: "saturday", title: "Sunday invite & preview", weekday: 6 },
    { run: "friday", key: "friday", title: "Weekly blog", weekday: 5 },
  ];
  let n = 0;
  for (const s of seeds) {
    const exists = await db.query("SELECT 1 FROM recurrences WHERE draft_key = $1 AND event_id = $2", [s.key, RUN_EVENTS[s.run].id]);
    if (exists.rowCount) continue;
    await createRecurrence(db, {
      title: s.title, eventId: RUN_EVENTS[s.run].id, platforms: DEFAULT_PLATFORMS, noMediaNeeded: true,
      rule: { freq: "weekly", interval: 1, weekdays: [s.weekday], monthDay: null, nth: null, weekday: null,
              startDate: today, endDate: null, count: null },
    }, "seed", today, s.key);
    n++;
  }
  return n;
}
