// Breeze → Social Posts sync (spec §3): every ticked calendar's events become
// Social Posts events with their checklist. Nothing here deletes anything; an
// event Breeze stops returning is only flagged, and only when its calendar
// was read successfully this run.
import { Pool, PoolClient } from "pg";
import type { FetchFn } from "../gracenotes/mail";
import { BreezeInstance, listInstances, loadBreezeConfig, tickedCalendars } from "../breeze";
import { addDays } from "../dates";
import { getSetting, setSetting } from "../settings";
import { ChecklistRule, RuleRepeatMode, SeriesMode, resolveChecklist } from "./checklist";
import { applyChecklist, listRules } from "./checklist-repo";
import { createEvent } from "./repo";
import { DONE_MEDIA, Result } from "./rules";

type Db = Pool | PoolClient;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const WINDOW_DAYS = 90;
const SYNC_BY = "Breeze sync";
const DONE_POSTS = ["scheduled", "published", "cancelled"];

export interface SyncReport {
  calendars: number; created: number; updated: number; shifted: number;
  flaggedMissing: number; cleared: number; becameSeries: number;
  failedCalendars: string[]; skipped?: "not-connected" | "no-calendars";
}
type Tally = Pick<SyncReport, "created" | "updated" | "shifted" | "becameSeries">;

// ── Pure decisions ──────────────────────────────────────────────────────────

/** Instances inside the window, grouped by Breeze series, each group in date order. */
export function groupBySeries(instances: BreezeInstance[], from: string, to: string): Map<string, BreezeInstance[]> {
  const groups = new Map<string, BreezeInstance[]>();
  const inWindow = instances.filter((i) => i.date >= from && i.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.instanceId.localeCompare(b.instanceId));
  for (const i of inWindow) {
    const g = groups.get(i.seriesId);
    if (g) g.push(i); else groups.set(i.seriesId, [i]);
  }
  return groups;
}

/** A series seen for the first time: a rule's repeat mode wins, else one instance is a one-off. */
export function newSeriesMode(repeatMode: RuleRepeatMode | null, instanceCount: number):
  { mode: SeriesMode; source: "rule" | "auto" } {
  if (repeatMode) return { mode: repeatMode, source: "rule" };
  return { mode: instanceCount > 1 ? "series" : "single", source: "auto" };
}

/** A one-off that the sync decided on its own now repeats. */
export function becomesSeries(cur: { mode: string; mode_source: string }, instanceCount: number): boolean {
  return cur.mode === "single" && cur.mode_source === "auto" && instanceCount > 1;
}

// ── The run ─────────────────────────────────────────────────────────────────

interface Run { c: PoolClient; rules: ChecklistRule[]; owner: string; tally: Tally }

export async function syncBreeze(pool: Pool, today: string, fetchFn: FetchFn = fetch): Promise<SyncReport> {
  const report: SyncReport = {
    calendars: 0, created: 0, updated: 0, shifted: 0, flaggedMissing: 0, cleared: 0, becameSeries: 0, failedCalendars: [],
  };
  const cfg = await loadBreezeConfig(pool);
  if (!cfg) return { ...report, skipped: "not-connected" };
  const cals = await tickedCalendars(pool);
  if (!cals.length) return { ...report, skipped: "no-calendars" };
  report.calendars = cals.length;

  const to = addDays(today, WINDOW_DAYS);
  const rules = await listRules(pool);
  const owner = await getSetting(pool, "breeze_default_owner");
  // Only calendars read in full this run may flag or clear anything.
  const okCals: string[] = [], seenInstances: string[] = [], seenSeries: string[] = [];

  for (const cal of cals) {
    let groups: Map<string, BreezeInstance[]>;
    try {
      groups = groupBySeries(await listInstances(cfg, cal, today, to, fetchFn), today, to);
    } catch (e) {
      console.warn(`[breeze-sync] calendar ${cal} not read:`, (e as Error).message);
      report.failedCalendars.push(cal);
      continue;
    }
    const tally: Tally = { created: 0, updated: 0, shifted: 0, becameSeries: 0 };
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // Two runs at once (timer and "Sync now") would otherwise both create the same event.
      await c.query("SELECT pg_advisory_xact_lock(hashtext('breeze_sync'))");
      for (const [seriesId, group] of groups) await syncSeries(c, cal, seriesId, group, { c, rules, owner, tally });
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      console.warn(`[breeze-sync] calendar ${cal} not saved:`, (e as Error).message);
      report.failedCalendars.push(cal);
      continue;
    } finally {
      c.release();
    }
    for (const k of Object.keys(tally) as (keyof Tally)[]) report[k] += tally[k];
    okCals.push(cal);
    for (const [seriesId, group] of groups) {
      seenSeries.push(seriesId);
      for (const i of group) seenInstances.push(i.instanceId);
    }
  }

  if (okCals.length) {
    const m = await markMissing(pool, okCals, seenInstances, seenSeries, today, to);
    report.flaggedMissing = m.flagged;
    report.cleared = m.cleared;
  }
  await setSetting(pool, "breeze_last_sync", new Date().toISOString());
  // Kept beside the time so Settings never shows an outage as a clean sync.
  await setSetting(pool, "breeze_last_sync_failed", JSON.stringify(report.failedCalendars));
  return report;
}

async function syncSeries(c: PoolClient, cal: string, seriesId: string, group: BreezeInstance[], run: Run) {
  const mode = await upsertSeries(c, cal, seriesId, group, run);
  if (mode === "ignore") return;
  const dates = new Map(group.map((i) => [i.instanceId, i.date]));
  if (mode === "series") {
    const next = group[0];
    const ev = (await c.query(
      "SELECT * FROM events WHERE source = 'breeze' AND breeze_event_id = $1 AND breeze_instance_id IS NULL", [seriesId],
    )).rows[0];
    if (!ev) await createSynced(run, { inst: next, instanceId: null });
    else await refresh(run, ev, next.name, next.date, cal, dates);
    return;
  }
  for (const i of group) {
    const ev = (await c.query("SELECT * FROM events WHERE breeze_instance_id = $1", [i.instanceId])).rows[0];
    if (!ev) await createSynced(run, { inst: i, instanceId: i.instanceId });
    else await refresh(run, ev, i.name, i.date, cal, dates);
  }
}

async function upsertSeries(c: PoolClient, cal: string, seriesId: string, group: BreezeInstance[], run: Run): Promise<SeriesMode> {
  const name = group[0].name;
  const cur = (await c.query("SELECT mode, mode_source FROM breeze_series WHERE breeze_event_id = $1", [seriesId])).rows[0];
  if (!cur) {
    const { mode, source } = newSeriesMode(resolveChecklist(run.rules, { calendarId: cal, name }).repeatMode, group.length);
    await c.query(
      "INSERT INTO breeze_series (breeze_event_id, name, calendar_id, mode, mode_source) VALUES ($1,$2,$3,$4,$5)",
      [seriesId, name, cal, mode, source],
    );
    return mode;
  }
  await c.query("UPDATE breeze_series SET name = $2, calendar_id = $3 WHERE breeze_event_id = $1", [seriesId, name, cal]);
  if (!becomesSeries(cur, group.length)) return cur.mode;
  await c.query("UPDATE breeze_series SET mode = 'series', became_series_at = now() WHERE breeze_event_id = $1", [seriesId]);
  await rekeyToSeries(c, seriesId, group);
  run.tally.becameSeries++;
  return "series";
}

// The one-off's event becomes the series event, keeping its checklist and anchor.
async function rekeyToSeries(c: PoolClient, seriesId: string, group: BreezeInstance[]) {
  const has = await c.query(
    "SELECT 1 FROM events WHERE source = 'breeze' AND breeze_event_id = $1 AND breeze_instance_id IS NULL", [seriesId]);
  if (has.rowCount) return;
  const ids = group.map((i) => i.instanceId);
  await c.query(
    `UPDATE events SET breeze_instance_id = NULL WHERE id = (
       SELECT id FROM events WHERE source = 'breeze' AND breeze_event_id = $1 AND breeze_instance_id IS NOT NULL
       ORDER BY (breeze_instance_id = ANY($2::text[])) DESC, created_at LIMIT 1)`,
    [seriesId, ids],
  );
}

async function createSynced(run: Run, o: { inst: BreezeInstance; instanceId: string | null }) {
  const { c, owner } = run;
  const { inst } = o;
  const ev = await createEvent(c, { name: inst.name, kind: "event", startDate: inst.date, ownerEmail: owner });
  await c.query(
    `UPDATE events SET source = 'breeze', breeze_event_id = $2, breeze_instance_id = $3, breeze_calendar_id = $4,
            synced_at = now(), anchor_date = $5, anchor_instance_id = $6 WHERE id = $1`,
    [ev.id, inst.seriesId, o.instanceId, inst.calendarId, inst.date, inst.instanceId],
  );
  const { items } = resolveChecklist(run.rules, { calendarId: inst.calendarId, name: inst.name });
  if (items.length) await applyChecklist(c, ev.id, items, { name: inst.name, date: inst.date, ownerEmail: owner }, SYNC_BY);
  run.tally.created++;
}

async function refresh(
  run: Run, ev: Record<string, any>, name: string, startDate: string, cal: string, dates: Map<string, string>,
) {
  const { c, tally } = run;
  await c.query("UPDATE events SET name = $2, start_date = $3, breeze_calendar_id = $4, synced_at = now() WHERE id = $1",
    [ev.id, name, startDate, cal]);
  if (ev.name !== name || ev.start_date !== startDate || ev.breeze_calendar_id !== cal) tally.updated++;
  // Only the anchored instance's own date moving is a move; a series rolling on to next week is not.
  const moved = ev.anchor_instance_id ? dates.get(ev.anchor_instance_id) : undefined;
  if (!moved || moved === ev.anchor_date) return;
  await c.query("UPDATE events SET anchor_date = $2 WHERE id = $1", [ev.id, moved]);
  await shiftChecklist(c, ev.id, moved);
  tally.shifted++;
}

// Recomputed from the rule's offset, so a second run can't shift twice. Direct
// SQL on purpose: updateContent/updateMedia would mark these dates hand-edited.
async function shiftChecklist(c: PoolClient, eventId: string, anchor: string) {
  await c.query(
    `UPDATE content_items SET publish_date = $2::date - rule_days_before, updated_at = now()
     WHERE event_id = $1 AND rule_days_before IS NOT NULL AND NOT due_edited AND status <> ALL($3::text[])`,
    [eventId, anchor, DONE_POSTS],
  );
  await c.query(
    `UPDATE media_assets SET gather_date = $2::date - rule_days_before, updated_at = now()
     WHERE (event_id = $1 OR content_item_id IN (SELECT id FROM content_items WHERE event_id = $1))
       AND rule_days_before IS NOT NULL AND NOT due_edited AND status <> ALL($3::text[])`,
    [eventId, anchor, DONE_MEDIA],
  );
}

/**
 * Flag and un-flag "removed from Breeze". Only events on calendars read in
 * full this run are considered. An occurrence must have been due inside the
 * window; a series is flagged only when none of it is left and its last known
 * date hasn't simply passed (a series that ended is not "removed"). An event
 * the user chose to Keep is never flagged again.
 */
async function markMissing(
  pool: Pool, okCals: string[], instances: string[], series: string[], today: string, to: string,
): Promise<{ flagged: number; cleared: number }> {
  const cleared = await pool.query(
    `UPDATE events SET breeze_missing_since = NULL
     WHERE source = 'breeze' AND breeze_missing_since IS NOT NULL
       AND ((breeze_instance_id IS NOT NULL AND breeze_instance_id = ANY($1::text[]))
         OR (breeze_instance_id IS NULL AND breeze_event_id = ANY($2::text[])))`,
    [instances, series],
  );
  const flagged = await pool.query(
    `UPDATE events SET breeze_missing_since = now()
     WHERE source = 'breeze' AND breeze_missing_since IS NULL AND NOT archived AND NOT breeze_kept
       AND breeze_calendar_id = ANY($1::text[])
       AND ((breeze_instance_id IS NOT NULL AND NOT (breeze_instance_id = ANY($2::text[]))
              AND start_date BETWEEN $4::date AND $5::date)
         OR (breeze_instance_id IS NULL AND NOT (breeze_event_id = ANY($3::text[])) AND start_date >= $4::date))`,
    [okCals, instances, series, today, to],
  );
  return { flagged: flagged.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

// ── Series modes and re-applying rules ──────────────────────────────────────

export async function setSeriesMode(db: Db, breezeEventId: string, mode: Exclude<SeriesMode, "single">): Promise<Result<true>> {
  if (!["series", "each", "ignore"].includes(mode)) return fail("Mode must be series, each or ignore.");
  const r = await db.query("UPDATE breeze_series SET mode = $2, mode_source = 'user' WHERE breeze_event_id = $1",
    [breezeEventId, mode]);
  return r.rowCount ? { ok: true, value: true } : fail("Breeze event not found.");
}

export async function listSeries(db: Db): Promise<Array<{
  breezeEventId: string; name: string; calendarId: string; mode: SeriesMode; modeSource: string; eventCount: number;
}>> {
  const r = await db.query(
    `SELECT s.*, (SELECT count(*) FROM events e WHERE e.source = 'breeze' AND e.breeze_event_id = s.breeze_event_id) AS n
     FROM breeze_series s ORDER BY lower(s.name), s.breeze_event_id`,
  );
  return r.rows.map((s) => ({
    breezeEventId: s.breeze_event_id, name: s.name, calendarId: s.calendar_id, mode: s.mode,
    modeSource: s.mode_source, eventCount: Number(s.n),
  }));
}

/** "Apply rules again" for an event with no checklist yet; never over an existing one. */
export async function applyRulesToEvent(db: Db, eventId: string): Promise<Result<{ posts: number; graphics: number }>> {
  const owned = db instanceof Pool ? await db.connect() : null;
  const c = owned ?? (db as PoolClient);
  try {
    if (owned) await c.query("BEGIN");
    const r = await applyRulesIn(c, eventId);
    if (owned) await c.query(r.ok ? "COMMIT" : "ROLLBACK");
    return r;
  } catch (e) {
    if (owned) await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    owned?.release();
  }
}

async function applyRulesIn(c: PoolClient, eventId: string): Promise<Result<{ posts: number; graphics: number }>> {
  // The row lock makes a double click wait, then see the first click's checklist.
  const ev = (await c.query("SELECT * FROM events WHERE id = $1 FOR UPDATE", [eventId])).rows[0];
  if (!ev) return fail("Event not found.");
  const has = await c.query(
    `SELECT 1 FROM content_items WHERE event_id = $1 UNION ALL SELECT 1 FROM media_assets WHERE event_id = $1 LIMIT 1`,
    [eventId]);
  if (has.rowCount) return fail("This event already has posts or graphics, so rules can't be applied again.");
  const date: string | null = ev.anchor_date ?? ev.start_date;
  if (!date) return fail("Give the event a date first.");
  const { items } = resolveChecklist(await listRules(c), { calendarId: ev.breeze_calendar_id ?? "", name: ev.name });
  if (!items.length) return fail("No checklist rule matches this event.");
  const counts = await applyChecklist(c, eventId, items, { name: ev.name, date, ownerEmail: ev.owner_email }, "Checklist rules");
  await c.query("UPDATE events SET anchor_date = COALESCE(anchor_date, $2::date) WHERE id = $1", [eventId, date]);
  return { ok: true, value: counts };
}
