import { PoolClient } from "pg";
import { BreezeInstance } from "../breeze";
import { ChecklistRule, resolveChecklist } from "./checklist";
import { applyChecklist } from "./checklist-repo";

// Two Breeze copies are "the same event" only when the name matches exactly
// apart from case and spacing, so near-misses are never merged by accident.
export function matchKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface Cluster {
  key: string;
  seriesIds: string[];
  calendarIds: string[];
  byDate: Map<string, BreezeInstance[]>;
}

export function clusterCopies(groups: Map<string, BreezeInstance[]>, calendarOrder: string[]): Cluster[] {
  const rank = (cal: string) => { const i = calendarOrder.indexOf(cal); return i < 0 ? Infinity : i; };
  const cmpCal = (a: string, b: string) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };

  const seriesKey = new Map<string, string>();
  const seen = new Map<string, string>(); // matchKey + date -> first series id
  for (const [sid, list] of groups) {
    parent.set(sid, sid);
    seriesKey.set(sid, matchKey(list[0]?.name ?? ""));
  }
  for (const [sid, list] of groups) {
    for (const inst of list) {
      const k = matchKey(inst.name) + "\u0000" + inst.date;
      const first = seen.get(k);
      if (first === undefined) seen.set(k, sid); else union(first, sid);
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const sid of groups.keys()) {
    const r = find(sid);
    byRoot.set(r, [...(byRoot.get(r) ?? []), sid]);
  }

  const out: Cluster[] = [];
  for (const sids of byRoot.values()) {
    const all = sids.flatMap(s => groups.get(s)!);
    const byDate = new Map<string, BreezeInstance[]>();
    for (const d of [...new Set(all.map(i => i.date))].sort()) {
      byDate.set(d, all.filter(i => i.date === d).sort((a, b) =>
        cmpCal(a.calendarId, b.calendarId) || (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0)));
    }
    out.push({
      key: seriesKey.get(sids[0])!,
      seriesIds: sids,
      calendarIds: [...new Set(all.map(i => i.calendarId))].sort(cmpCal),
      byDate,
    });
  }
  const first = (c: Cluster) => c.byDate.keys().next().value as string;
  return out.sort((a, b) => (first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ── Events that are already duplicated ──────────────────────────────────────

const SYNC_BY = "Breeze sync";

/**
 * The oldest live Breeze event with this name and date, of the same shape
 * (series event or per-date event). A copy seen for the first time while the
 * calendar of its twin was down joins this event instead of making a second one.
 */
export async function sameEvent(
  c: PoolClient, key: string, date: string, series: boolean,
): Promise<Record<string, any> | undefined> {
  const rows = (await c.query(
    `SELECT * FROM events WHERE source = 'breeze' AND NOT archived AND start_date = $1
        AND (breeze_instance_id IS NULL) = $2 ORDER BY created_at, id`, [date, series])).rows;
  return rows.find((e) => matchKey(e.name) === key);
}

/**
 * Puts these Breeze series (and any merged into them) under the series that
 * `target` is or belongs to, sharing its mode, so merges never chain.
 */
export async function mergeSeriesInto(c: PoolClient, target: string, seriesIds: string[]) {
  const t = (await c.query("SELECT * FROM breeze_series WHERE breeze_event_id = $1", [target])).rows[0];
  if (!t) return;
  const root = t.merged_into
    ? (await c.query("SELECT * FROM breeze_series WHERE breeze_event_id = $1", [t.merged_into])).rows[0] ?? t
    : t;
  const ids = seriesIds.filter((s) => s !== root.breeze_event_id);
  if (!ids.length) return;
  await c.query(
    `UPDATE breeze_series SET merged_into = $1, mode = $2, mode_source = $3
      WHERE (breeze_event_id = ANY($4::text[]) OR merged_into = ANY($4::text[])) AND breeze_event_id <> $1`,
    [root.breeze_event_id, root.mode, root.mode_source, ids]);
}

// Anything here means someone worked on the event, so its group is left as is.
// Stricter than "unedited" needs to be: a false "touched" only leaves a duplicate showing.
// A rule-made graphic always has a due date, so it starts out "scheduled", not
// "needed"; any other status, or no date, means someone changed it.
const TOUCHED = `
  e.notes <> '' OR e.image_url <> '' OR e.breeze_kept OR e.review_note <> '' OR e.end_date IS NOT NULL
  OR e.series_id IS NOT NULL OR e.drafting <> '{}'::jsonb
  OR EXISTS (SELECT 1 FROM recurrences r WHERE r.event_id = e.id)
  OR EXISTS (SELECT 1 FROM gn_pieces g WHERE g.event_id = e.id)
  OR EXISTS (SELECT 1 FROM content_items ci WHERE ci.event_id = e.id AND (
       ci.rule_days_before IS NULL OR ci.status <> 'planned' OR ci.due_edited OR ci.brief <> '' OR ci.caption <> ''
       OR ci.draft_id IS NOT NULL OR ci.captions <> '{}'::jsonb OR ci.drafting <> '{}'::jsonb OR ci.source_ref IS NOT NULL
       OR ci.no_media_needed OR ci.publish_time IS NOT NULL OR ci.recurrence_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM metricool_links ml WHERE ml.content_item_id = ci.id)
       OR EXISTS (SELECT 1 FROM post_drafts pd WHERE pd.content_item_id = ci.id)))
  OR EXISTS (SELECT 1 FROM media_assets ma
              WHERE (ma.event_id = e.id OR ma.content_item_id IN (SELECT id FROM content_items WHERE event_id = e.id)) AND (
       ma.rule_days_before IS NULL OR ma.gather_date IS NULL OR ma.status <> 'scheduled' OR ma.due_edited OR ma.file_link <> '' OR ma.notes <> ''
       OR ma.assignee_email <> '' OR ma.approval_id IS NOT NULL OR ma.gather_location <> ''))`;

/**
 * One-time cleanup (harmless on later runs) of Breeze events duplicated before
 * copies were merged: a group with the same name and date where nobody has
 * touched anything becomes its oldest event, with every copy's link and one
 * checklist from all its calendars. A touched group is left alone; the
 * dashboard shows it. Returns how many events were removed.
 */
export async function mergeDuplicates(c: PoolClient, rules: ChecklistRule[], calendarOrder: string[]): Promise<number> {
  const rows = (await c.query(
    `SELECT * FROM events WHERE source = 'breeze' AND NOT archived AND start_date IS NOT NULL ORDER BY created_at, id`)).rows;
  const groups = new Map<string, Record<string, any>[]>();
  for (const e of rows) {
    const k = matchKey(e.name) + "\u0000" + e.start_date;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // A series event and a per-date event aren't the same shape; leave them to the user.
    if (new Set(group.map((e) => e.breeze_instance_id === null)).size > 1) continue;
    const ids = group.map((e) => e.id);
    const touched = await c.query(`SELECT 1 FROM events e WHERE e.id = ANY($1::text[]) AND (${TOUCHED}) LIMIT 1`, [ids]);
    if (touched.rowCount) continue;
    const [keep, ...rest] = group;
    const others = rest.map((e) => e.id);

    const moved = (await c.query(
      "UPDATE breeze_links SET event_id = $1 WHERE event_id = ANY($2::text[]) RETURNING breeze_event_id, breeze_instance_id",
      [keep.id, others])).rows;
    const movedSeries = moved.filter((l) => l.breeze_instance_id === null).map((l) => l.breeze_event_id);
    if (movedSeries.length) await mergeSeriesInto(c, keep.breeze_event_id, movedSeries);

    // content_items.event_id is ON DELETE SET NULL, so posts go first; graphics cascade.
    await c.query("DELETE FROM content_items WHERE event_id = ANY($1::text[])", [[keep.id, ...others]]);
    await c.query("DELETE FROM media_assets WHERE event_id = $1", [keep.id]);
    await c.query("DELETE FROM events WHERE id = ANY($1::text[])", [others]);
    removed += others.length;

    const cals: string[] = (await c.query(
      "SELECT DISTINCT calendar_id FROM breeze_links WHERE event_id = $1", [keep.id])).rows.map((r) => r.calendar_id);
    const rank = (id: string) => { const i = calendarOrder.indexOf(id); return i < 0 ? Infinity : i; };
    cals.sort((a, b) => (rank(a) - rank(b)) || (a < b ? -1 : a > b ? 1 : 0));
    const { items } = resolveChecklist(rules, { calendarIds: cals, name: keep.name });
    const date: string = keep.anchor_date ?? keep.start_date;
    if (items.length) await applyChecklist(c, keep.id, items, { name: keep.name, date, ownerEmail: keep.owner_email }, SYNC_BY);
  }
  return removed;
}
