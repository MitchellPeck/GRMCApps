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
import { Cluster, clusterCopies, mergeDuplicates, mergeSeriesInto, sameEvent } from "./breeze-dedupe";
import { DONE_MEDIA, Result } from "./rules";

type Db = Pool | PoolClient;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const WINDOW_DAYS = 90;
const SYNC_BY = "Breeze sync";
const DONE_POSTS = ["scheduled", "published", "cancelled"];

export interface SyncReport {
  calendars: number; created: number; updated: number; shifted: number;
  flaggedMissing: number; cleared: number; becameSeries: number; merged: number;
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
/** One Breeze copy as a link row: a series link has no instance id. */
interface Copy { seriesId: string; instanceId: string | null; calendarId: string }

export async function syncBreeze(pool: Pool, today: string, fetchFn: FetchFn = fetch): Promise<SyncReport> {
  const report: SyncReport = {
    calendars: 0, created: 0, updated: 0, shifted: 0, flaggedMissing: 0, cleared: 0, becameSeries: 0, merged: 0, failedCalendars: [],
  };
  const cfg = await loadBreezeConfig(pool);
  if (!cfg) return { ...report, skipped: "not-connected" };
  const cals = await tickedCalendars(pool);
  if (!cals.length) return { ...report, skipped: "no-calendars" };
  report.calendars = cals.length;

  const to = addDays(today, WINDOW_DAYS);
  const rules = await listRules(pool);
  const owner = await getSetting(pool, "breeze_default_owner");

  // Read every calendar first, so copies of one event on several calendars can
  // be saved as one. A calendar that fails to read just has no copies this run.
  const readCals: string[] = [], all: BreezeInstance[] = [];
  for (const cal of cals) {
    try {
      all.push(...await listInstances(cfg, cal, today, to, fetchFn));
      readCals.push(cal);
    } catch (e) {
      console.warn(`[breeze-sync] calendar ${cal} not read:`, (e as Error).message);
      report.failedCalendars.push(cal);
    }
  }
  const groups = groupBySeries(all, today, to);
  const clusters = clusterCopies(groups, cals);

  const tally: Tally = { created: 0, updated: 0, shifted: 0, becameSeries: 0 };
  let saved = false;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // Two runs at once (timer and "Sync now") would otherwise both create the same event.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('breeze_sync'))");
    // Duplicates made before copies were merged go first, so the clusters below find one event.
    const merged = await mergeDuplicates(c, rules, cals);
    const run: Run = { c, rules, owner, tally };
    for (const cluster of clusters) await syncCluster(run, cluster);
    await c.query("COMMIT");
    saved = true;
    report.merged = merged;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    console.warn("[breeze-sync] not saved:", (e as Error).message);
    report.failedCalendars.push(...readCals);
  } finally {
    c.release();
  }

  // Only calendars read in full and saved this run may flag or clear anything.
  if (saved) {
    for (const k of Object.keys(tally) as (keyof Tally)[]) report[k] += tally[k];
    if (readCals.length) {
      const seenSeries = [...groups.keys()];
      const seenInstances = [...groups.values()].flat().map((i) => i.instanceId);
      const m = await markMissing(pool, readCals, seenInstances, seenSeries, today, to);
      report.flaggedMissing = m.flagged;
      report.cleared = m.cleared;
    }
  }
  report.failedCalendars.sort((a, b) => cals.indexOf(a) - cals.indexOf(b));
  await setSetting(pool, "breeze_last_sync", new Date().toISOString());
  // Kept beside the time so Settings never shows an outage as a clean sync.
  await setSetting(pool, "breeze_last_sync_failed", JSON.stringify(report.failedCalendars));
  return report;
}

/** One real-world event (or series) and all its Breeze copies across calendars. */
async function syncCluster(run: Run, cluster: Cluster) {
  const { c } = run;
  const mode = await upsertSeries(run, cluster);
  if (mode === "ignore") return;
  const copies = [...cluster.byDate.values()].flat();
  const dates = new Map(copies.map((i) => [i.instanceId, i.date]));

  if (mode === "series") {
    const calOf = new Map(copies.map((i) => [i.seriesId, i.calendarId]));
    const want: Copy[] = cluster.seriesIds.map((s) => ({ seriesId: s, instanceId: null, calendarId: calOf.get(s)! }));
    const first = cluster.byDate.values().next().value![0];
    const ev = await linkedEvent(c,
      "l.breeze_instance_id IS NULL AND l.breeze_event_id = ANY($1::text[])", cluster.seriesIds)
      ?? await joinSame(c, cluster, first.date, true);
    if (!ev) await createSynced(run, first, null, want, cluster.calendarIds);
    else {
      await addLinks(c, ev.id, want);
      await refresh(run, ev, first, copies, dates);
    }
    return;
  }
  for (const group of cluster.byDate.values()) {
    const ids = group.map((i) => i.instanceId);
    const want: Copy[] = group.map((i) => ({ seriesId: i.seriesId, instanceId: i.instanceId, calendarId: i.calendarId }));
    const ev = await linkedEvent(c, "l.breeze_instance_id = ANY($1::text[])", ids)
      ?? await joinSame(c, cluster, group[0].date, false);
    if (!ev) await createSynced(run, group[0], group[0].instanceId, want, [...new Set(group.map((i) => i.calendarId))]);
    else {
      await addLinks(c, ev.id, want);
      await refresh(run, ev, group[0], group, dates);
    }
  }
}

// The event the earliest-linked of these copies points at. If copies point at
// two events, new copies join the earlier one; merging is not done here.
async function linkedEvent(c: PoolClient, where: string, ids: string[]): Promise<Record<string, any> | undefined> {
  return (await c.query(
    `SELECT e.* FROM breeze_links l JOIN events e ON e.id = l.event_id
      WHERE e.source = 'breeze' AND ${where} ORDER BY l.created_at, e.created_at, l.id LIMIT 1`, [ids],
  )).rows[0];
}

// No copy is linked yet, but an event with this name and date may already
// exist (its copy's calendar can be down this run): join it, don't make a twin.
async function joinSame(c: PoolClient, cluster: Cluster, date: string, series: boolean) {
  const ev = await sameEvent(c, cluster.key, date, series);
  if (ev && series) await mergeSeriesInto(c, ev.breeze_event_id, cluster.seriesIds);
  return ev;
}

/** Links the copies not linked to any event yet; a copy already on another event stays there. */
async function addLinks(c: PoolClient, eventId: string, copies: Copy[]) {
  for (const k of copies) {
    await c.query(
      `INSERT INTO breeze_links (event_id, breeze_event_id, breeze_instance_id, calendar_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [eventId, k.seriesId, k.instanceId, k.calendarId]);
  }
}

/**
 * Saves the cluster's breeze_series rows and returns the mode to sync with.
 * The primary is the oldest series already on its own (not merged); the rest
 * are merged into it and share its mode.
 */
async function upsertSeries(run: Run, cluster: Cluster): Promise<SeriesMode> {
  const { c } = run;
  const rows = new Map<string, Record<string, any>>((await c.query(
    "SELECT * FROM breeze_series WHERE breeze_event_id = ANY($1::text[]) ORDER BY first_seen_at, breeze_event_id",
    [cluster.seriesIds])).rows.map((r) => [r.breeze_event_id, r]));
  const firstOf = new Map<string, BreezeInstance>();
  for (const i of [...cluster.byDate.values()].flat()) if (!firstOf.has(i.seriesId)) firstOf.set(i.seriesId, i);

  // A cluster whose only known rows are merged copies follows their primary, so merges never chain.
  const own = [...rows.values()].find((r) => r.merged_into === null);
  let primaryId: string = own?.breeze_event_id ?? cluster.seriesIds[0];
  let primary: Record<string, any> | undefined = own;
  if (!own) {
    const target = [...rows.values()].find((r) => r.merged_into)?.merged_into as string | undefined;
    const t = target ? (await c.query("SELECT * FROM breeze_series WHERE breeze_event_id = $1", [target])).rows[0] : undefined;
    if (t && t.merged_into === null) { primaryId = t.breeze_event_id; primary = t; }
  }

  let mode: SeriesMode, source: string;
  if (primary) {
    mode = primary.mode; source = primary.mode_source;
    if (becomesSeries({ mode: primary.mode, mode_source: primary.mode_source }, cluster.byDate.size)) {
      mode = "series";
      await c.query("UPDATE breeze_series SET mode = 'series', became_series_at = now() WHERE breeze_event_id = $1", [primaryId]);
      await rekeyToSeries(c, cluster);
      run.tally.becameSeries++;
    }
  } else {
    const name = firstOf.get(primaryId)!.name;
    ({ mode, source } = newSeriesMode(
      resolveChecklist(run.rules, { calendarIds: cluster.calendarIds, name }).repeatMode, cluster.byDate.size));
  }

  for (const sid of cluster.seriesIds) {
    const { name, calendarId } = firstOf.get(sid)!;
    const merged = sid === primaryId ? null : primaryId;
    if (!rows.has(sid)) {
      await c.query(
        `INSERT INTO breeze_series (breeze_event_id, name, calendar_id, mode, mode_source, merged_into)
         VALUES ($1,$2,$3,$4,$5,$6)`, [sid, name, calendarId, mode, source, merged]);
    } else if (merged) {
      await c.query(
        `UPDATE breeze_series SET name = $2, calendar_id = $3, mode = $4, mode_source = $5, merged_into = $6
          WHERE breeze_event_id = $1`, [sid, name, calendarId, mode, source, merged]);
    } else {
      await c.query("UPDATE breeze_series SET name = $2, calendar_id = $3 WHERE breeze_event_id = $1", [sid, name, calendarId]);
    }
  }
  // A primary that now sits under another primary takes its copies along.
  if (primary) {
    await c.query(
      `UPDATE breeze_series SET merged_into = $1, mode = $2, mode_source = $3
        WHERE merged_into = ANY($4::text[]) AND breeze_event_id <> $1`,
      [primaryId, mode, source, cluster.seriesIds.filter((s) => s !== primaryId)]);
  }
  return mode;
}

// The one-off's event becomes the series event, keeping its checklist and anchor.
async function rekeyToSeries(c: PoolClient, cluster: Cluster) {
  const has = await c.query(
    "SELECT 1 FROM breeze_links WHERE breeze_instance_id IS NULL AND breeze_event_id = ANY($1::text[])", [cluster.seriesIds]);
  if (has.rowCount) return;
  const ids = [...cluster.byDate.values()].flat().map((i) => i.instanceId);
  const ev = (await c.query(
    `SELECT e.id, e.breeze_event_id FROM breeze_links l JOIN events e ON e.id = l.event_id
      WHERE e.source = 'breeze' AND l.breeze_instance_id IS NOT NULL AND l.breeze_event_id = ANY($1::text[])
      ORDER BY (l.breeze_instance_id = ANY($2::text[])) DESC, e.created_at, l.created_at LIMIT 1`,
    [cluster.seriesIds, ids])).rows[0];
  if (!ev) return;
  // Each of its instance links (one per series) becomes that series' link.
  await c.query(
    `UPDATE breeze_links SET breeze_instance_id = NULL WHERE id IN (
       SELECT DISTINCT ON (breeze_event_id) id FROM breeze_links
        WHERE event_id = $1 AND breeze_instance_id IS NOT NULL AND breeze_event_id = ANY($2::text[])
        ORDER BY breeze_event_id, created_at, id)`,
    [ev.id, cluster.seriesIds]);
  // events.breeze_* follow only if the event's own copy became a series link.
  await c.query(
    `UPDATE events e SET breeze_instance_id = NULL WHERE e.id = $1 AND EXISTS (
       SELECT 1 FROM breeze_links l WHERE l.event_id = e.id AND l.breeze_event_id = e.breeze_event_id
          AND l.breeze_instance_id IS NULL)`,
    [ev.id]);
}

async function createSynced(run: Run, inst: BreezeInstance, instanceId: string | null, copies: Copy[], calendarIds: string[]) {
  const { c, owner } = run;
  const ev = await createEvent(c, { name: inst.name, kind: "event", startDate: inst.date, ownerEmail: owner });
  // events.breeze_* are the first copy's, and match one of the links below.
  await c.query(
    `UPDATE events SET source = 'breeze', breeze_event_id = $2, breeze_instance_id = $3, breeze_calendar_id = $4,
            synced_at = now(), anchor_date = $5, anchor_instance_id = $6 WHERE id = $1`,
    [ev.id, inst.seriesId, instanceId, inst.calendarId, inst.date, inst.instanceId],
  );
  await addLinks(c, ev.id, copies);
  const { items } = resolveChecklist(run.rules, { calendarIds, name: inst.name });
  if (items.length) await applyChecklist(c, ev.id, items, { name: inst.name, date: inst.date, ownerEmail: owner }, SYNC_BY);
  run.tally.created++;
}

// Name and date come from `from`. Every linked copy seen this run has its
// link's calendar follow a move; events.breeze_calendar_id follows the event's own copy.
async function refresh(
  run: Run, ev: Record<string, any>, from: BreezeInstance, seen: BreezeInstance[], dates: Map<string, string>,
) {
  const { c, tally } = run;
  const own = seen.find((i) => ev.breeze_instance_id ? i.instanceId === ev.breeze_instance_id : i.seriesId === ev.breeze_event_id);
  const cal: string = own?.calendarId ?? ev.breeze_calendar_id;
  await c.query("UPDATE events SET name = $2, start_date = $3, breeze_calendar_id = $4, synced_at = now() WHERE id = $1",
    [ev.id, from.name, from.date, cal]);
  await c.query(
    `UPDATE breeze_links l SET calendar_id = s.cal
       FROM unnest($2::text[], $3::text[], $4::text[]) AS s(sid, iid, cal)
      WHERE l.event_id = $1 AND l.breeze_event_id = s.sid AND l.calendar_id <> s.cal
        AND (l.breeze_instance_id = s.iid OR l.breeze_instance_id IS NULL)`,
    [ev.id, seen.map((i) => i.seriesId), seen.map((i) => i.instanceId), seen.map((i) => i.calendarId)]);
  if (ev.name !== from.name || ev.start_date !== from.date || ev.breeze_calendar_id !== cal) tally.updated++;
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
 * Flag and un-flag "removed from Breeze". An event can have several Breeze
 * copies (one link each). A link is seen when its instance id (or, for a
 * series link, its series id) came back this run. Any seen link clears the
 * event; it is flagged only when no link is seen AND every link's calendar was
 * read in full this run. An occurrence must have been due inside the window;
 * a series is flagged only when its last known date hasn't simply passed.
 * An event the user chose to Keep, or an archived one, is never flagged.
 */
async function markMissing(
  pool: Pool, okCals: string[], instances: string[], series: string[], today: string, to: string,
): Promise<{ flagged: number; cleared: number }> {
  const seen = `(l.breeze_instance_id IS NOT NULL AND l.breeze_instance_id = ANY($1::text[]))
             OR (l.breeze_instance_id IS NULL AND l.breeze_event_id = ANY($2::text[]))`;
  const cleared = await pool.query(
    `UPDATE events e SET breeze_missing_since = NULL
     WHERE e.source = 'breeze' AND e.breeze_missing_since IS NOT NULL
       AND EXISTS (SELECT 1 FROM breeze_links l WHERE l.event_id = e.id AND (${seen}))`,
    [instances, series],
  );
  const flagged = await pool.query(
    `UPDATE events e SET breeze_missing_since = now()
     WHERE e.source = 'breeze' AND e.breeze_missing_since IS NULL AND NOT e.archived AND NOT e.breeze_kept
       AND EXISTS (SELECT 1 FROM breeze_links l WHERE l.event_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM breeze_links l WHERE l.event_id = e.id
                         AND (${seen} OR NOT (l.calendar_id = ANY($3::text[]))))
       AND ((NOT EXISTS (SELECT 1 FROM breeze_links l WHERE l.event_id = e.id AND l.breeze_instance_id IS NULL)
             AND e.start_date BETWEEN $4::date AND $5::date)
         OR (EXISTS (SELECT 1 FROM breeze_links l WHERE l.event_id = e.id AND l.breeze_instance_id IS NULL)
             AND e.start_date >= $4::date))`,
    [instances, series, okCals, today, to],
  );
  return { flagged: flagged.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

// ── Series modes and re-applying rules ──────────────────────────────────────

export async function setSeriesMode(db: Db, breezeEventId: string, mode: Exclude<SeriesMode, "single">): Promise<Result<true>> {
  if (!["series", "each", "ignore"].includes(mode)) return fail("Mode must be series, each or ignore.");
  // A merged series' copies share its mode.
  const r = await db.query(
    `UPDATE breeze_series SET mode = $2, mode_source = 'user'
      WHERE breeze_event_id = $1 OR merged_into = $1 RETURNING breeze_event_id`, [breezeEventId, mode]);
  return r.rows.some((x) => x.breeze_event_id === breezeEventId) ? { ok: true, value: true } : fail("Breeze event not found.");
}

export async function listSeries(db: Db): Promise<Array<{
  breezeEventId: string; name: string; calendarId: string; mode: SeriesMode; modeSource: string; eventCount: number;
}>> {
  const r = await db.query(
    // One row per merged series; its events are counted through every copy's links.
    `SELECT s.*, (SELECT count(DISTINCT l.event_id) FROM breeze_links l JOIN events e ON e.id = l.event_id
                   WHERE e.source = 'breeze' AND (l.breeze_event_id = s.breeze_event_id OR l.breeze_event_id IN
                     (SELECT m.breeze_event_id FROM breeze_series m WHERE m.merged_into = s.breeze_event_id))) AS n
     FROM breeze_series s WHERE s.merged_into IS NULL ORDER BY lower(s.name), s.breeze_event_id`,
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

/** The event's linked calendars, in the ticked-list order; unticked ones last, by id. */
export async function eventCalendarIds(db: Db, eventId: string): Promise<string[]> {
  const ids: string[] = (await db.query(
    "SELECT DISTINCT calendar_id FROM breeze_links WHERE event_id = $1", [eventId])).rows.map((r) => r.calendar_id);
  const ticked = await tickedCalendars(db);
  const rank = (id: string) => { const i = ticked.indexOf(id); return i < 0 ? Infinity : i; };
  return ids.sort((a, b) => (rank(a) - rank(b)) || (a < b ? -1 : a > b ? 1 : 0));
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
  const { items } = resolveChecklist(await listRules(c), { calendarIds: await eventCalendarIds(c, eventId), name: ev.name });
  if (!items.length) return fail("No checklist rule matches this event.");
  const counts = await applyChecklist(c, eventId, items, { name: ev.name, date, ownerEmail: ev.owner_email }, "Checklist rules");
  await c.query("UPDATE events SET anchor_date = COALESCE(anchor_date, $2::date) WHERE id = $1", [eventId, date]);
  return { ok: true, value: counts };
}
