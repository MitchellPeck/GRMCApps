// Makes the app's posts match Metricool's planner: follows posts Metricool
// gave new ids, applies moves, caption edits, deletions and each platform's
// published/failed state, splits posts whose platforms now go at different
// times, and imports posts made only in Metricool. Runs every 30 minutes and
// on demand; a Metricool failure only leaves a note.
import { Pool, PoolClient } from "pg";
import { getSetting, setSetting } from "../settings";
import { DEFAULT_TZ, addDays, localDateIn } from "../dates";
import { getMetricoolCreds } from "../metricool";
import { listPlanner, PlannerPost, textHash } from "../metricool-planner";
import { Link, linksFor, pendingIdlessSends } from "./metricool-links";
import { applyRelink, heldPostIds, refreshIdents, relinkPlan, type RelinkResult } from "./metricool-relink";
import { LinkChange, overallStatus, reconcileItem } from "./metricool-reconcile";
import { idlessSends, idlessSendsForRelink, importPlannerPost, shouldImport } from "./metricool-import";
import { splitContent } from "./repo";
import { logDraft } from "./history";

export const IMPORT_SINCE_SETTING = "metricool_import_since";

export interface SyncCounts {
  /** Platforms whose time changed. */ moved: number;
  /** Posts split because their platforms now go at different times. */ split: number;
  /** Posts whose caption was replaced by Metricool's. */ edited: number;
  /** Platforms deleted in Metricool. */ gone: number;
  imported: number;
  /** Posts that became Published. */ published: number;
  /** Posts that couldn't be synced this run (each carries a note); tried again next run. */ failed: number;
  /** Metricool-only posts that couldn't be imported; tried again next run. */ importFailed: number;
  /** 1 when following re-id'd posts failed this run (nothing is marked gone then); tried again next run. */ relinkFailed: number;
  /** Set when Metricool couldn't be read; nothing else changed. */ error?: string;
}

type Db = Pool | PoolClient;
interface Covered { from: string; to: string }

const UNPLACED = "Couldn't tell which Metricool post this is now.";
const dayOf = (l: Link) => l.scheduledFor.slice(0, 10);
// A range no day falls in: one-post syncs list only a few days, so absence there proves nothing.
const NOTHING_COVERED: Covered = { from: "~", to: "" };
const covers = (c: Covered, l: Link) => !!dayOf(l) && dayOf(l) >= c.from && dayOf(l) <= c.to;

// Runs one at a time: the 30-minute job and a button press overlapping could import the same post twice.
let queue: Promise<unknown> = Promise.resolve();

export function syncMetricool(pool: Pool, o: { itemId?: string; now?: Date } = {}): Promise<SyncCounts> {
  const run = queue.then(() => syncOnce(pool, o));
  queue = run.catch(() => undefined);
  return run;
}

async function syncOnce(pool: Pool, o: { itemId?: string; now?: Date }): Promise<SyncCounts> {
  const now = o.now || new Date();
  const tz = (await getSetting(pool, "default_timezone")) || DEFAULT_TZ;
  const today = localDateIn(tz, now);
  const counts: SyncCounts = { moved: 0, split: 0, edited: 0, gone: 0, imported: 0, published: 0, failed: 0, importFailed: 0, relinkFailed: 0 };
  // Go-live day: nothing dated before the first sync is ever imported.
  if (!(await getSetting(pool, IMPORT_SINCE_SETTING))) await setSetting(pool, IMPORT_SINCE_SETTING, today);

  const itemIds = o.itemId ? [o.itemId]
    : (await pool.query(`SELECT DISTINCT content_item_id FROM metricool_links WHERE content_item_id IS NOT NULL`)).rows.map((r) => r.content_item_id);
  const links = [...(await linksFor(pool, itemIds)).values()].flat();
  const dates = links.map(dayOf).filter(Boolean);
  if (o.itemId) dates.push(...await idlessDays(pool, o.itemId, now));
  dates.sort();
  let covered: Covered;
  if (o.itemId) {
    if (!dates.length) return counts;
    covered = { from: addDays(dates[0], -1), to: addDays(dates[dates.length - 1], 1) };
  } else {
    const last = dates.length ? addDays(dates[dates.length - 1], 1) : "";
    const ahead = addDays(today, 90);  // far enough out to catch posts made only in Metricool
    covered = { from: addDays(today, -30), to: last > ahead ? last : ahead };
  }
  const ranged = links.filter((l) => covers(covered, l));

  let planner: PlannerPost[];
  try {
    planner = await listPlanner(await getMetricoolCreds(pool), covered.from, covered.to, tz);
  } catch (e) {
    const reason = (e as Error).message;
    await pool.query(
      `UPDATE content_items SET publish_check = $2 WHERE id = ANY($1) AND status NOT IN ('published','cancelled') AND publish_check <> $2`,
      [[...new Set(ranged.map((l) => l.contentItemId))], "Couldn't check Metricool: " + reason]);
    return { ...counts, error: reason };
  }

  // Follow posts Metricool re-id'd (and sends that never got an id) before anything reads as gone.
  // Whatever the plan named is claimed (never imported); its unsure links are held (never marked gone).
  // A failed relink mustn't stop every run from here on: it's counted, and nothing is marked gone this
  // time (a link it would have followed would read as deleted). Reconcile and imports still run, except
  // that with no plan at all nothing is imported either (a re-id'd post would come in as a duplicate).
  const relinkFailed = (e: unknown) => {
    counts.relinkFailed = 1;
    console.warn("[metricool-sync] relink failed:", (e as Error).message);
  };
  try { await refreshIdents(pool, ranged, planner); } catch (e) { relinkFailed(e); }
  let plan: RelinkResult | null = null;
  let applied = false;
  try {
    const idless = (await idlessSendsForRelink(pool, tz)).filter((s) => !o.itemId || s.itemId === o.itemId);
    plan = relinkPlan(ranged, planner, idless, await heldPostIds(pool));
    await applyRelink(pool, plan.entries);
    applied = true;
  } catch (e) { relinkFailed(e); }
  const relinked = !counts.relinkFailed;
  const claimed = new Set([...(plan?.entries || []).map((e) => e.toPostId), ...(plan?.contested || [])]);
  const unsure = new Set((plan?.unsure || []).map((l) => `${l.metricoolPostId}|${l.network}`));

  const touched = new Set([...ranged.map((l) => l.contentItemId), ...(applied ? plan!.entries.map((e) => e.itemId) : [])]);
  const byId = new Map(planner.map((p) => [p.id, p]));
  // Only the full run marks links gone; a post moved beyond a one-post window would otherwise read as deleted.
  const goneRange = o.itemId || !relinked ? NOTHING_COVERED : covered;
  for (const [itemId, itemLinks] of await linksFor(pool, [...touched])) {
    try {
      await syncItem(pool, itemId, itemLinks, byId, goneRange, tz, now, counts, unsure);
    } catch (e) {
      // One broken post mustn't stop the others (or the imports) on every run from now on.
      counts.failed++;
      await pool.query(`UPDATE content_items SET publish_check = $2 WHERE id = $1 AND publish_check <> $2`,
        [itemId, "Couldn't sync with Metricool: " + (e as Error).message]);
    }
  }

  if (!o.itemId && plan) {
    const linked = await heldPostIds(pool);
    const sent = new Set((await pool.query(
      `SELECT DISTINCT metricool_post_id FROM metricool_sends WHERE metricool_post_id <> ''`)).rows.map((r) => String(r.metricool_post_id)));
    const since = await getSetting(pool, IMPORT_SINCE_SETTING);
    const unsent = await idlessSends(pool);
    for (const p of planner) {
      if (!shouldImport(p, linked, sent, since, unsent, claimed)) continue;
      // One unreadable post mustn't stop the rest; it isn't linked, so the next run tries again.
      try { await importPlannerPost(pool, p, tz); counts.imported++; } catch { counts.importFailed++; }
    }
  }
  return counts;
}

/**
 * A send Metricool gave no id has no link, so a one-post window built from links alone would never
 * list it: add its date and the post's own, so the relink can find it. Only sends still pending count.
 */
async function idlessDays(pool: Pool, itemId: string, now: Date): Promise<string[]> {
  const sends = await pendingIdlessSends(pool, itemId, now);
  if (!sends.length) return [];
  const item = (await pool.query(`SELECT publish_date::text AS d FROM content_items WHERE id = $1`, [itemId])).rows[0];
  return [...sends.map((s) => s.day), item?.d].filter((d): d is string => /^\d{4}-\d{2}-\d{2}$/.test(d || ""));
}

async function syncItem(
  pool: Pool, itemId: string, links: Link[], planner: Map<string, PlannerPost>, covered: Covered, tz: string, now: Date,
  counts: SyncCounts, unsure: Set<string>,
): Promise<void> {
  const { changes, groups, unknown } = reconcileItem(links, planner, covered, unsure);
  // A vanished post a relink couldn't place: the link stays as it is, with a note.
  const unplaced = links.filter((l) => unsure.has(`${l.metricoolPostId}|${l.network}`) && !planner.has(l.metricoolPostId));
  const notes = unplaced.length ? [UNPLACED] : [];
  const changeOf = new Map<Link, LinkChange>(changes.map((c) => [c.link, c]));
  // The links as they stand once the changes are written.
  const after: Link[] = links.map((l) => {
    const c = changeOf.get(l);
    if (!c) return l;
    return { ...l, state: c.state ?? l.state, detail: c.detail ?? l.detail, scheduledFor: c.scheduledFor ?? l.scheduledFor,
      goneAt: c.state === "gone" ? now.toISOString() : c.state ? null : l.goneAt };
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = (await client.query(
      `SELECT caption, caption_mode, captions, platforms, publish_date::text AS d, to_char(publish_time, 'HH24:MI') AS t
         FROM content_items WHERE id = $1 FOR UPDATE`, [itemId])).rows[0];
    if (!item) { await client.query("ROLLBACK"); return; }
    for (const c of changes) await writeLinkChange(client, c, now);
    counts.moved += changes.filter((c) => c.scheduledFor !== undefined).length;
    counts.gone += changes.filter((c) => c.state === "gone").length;

    const edits = changes.filter((c) => c.text !== undefined);
    if (edits.length) {
      await replaceCaption(client, itemId, item, edits, after, planner);
      counts.edited++;
    }
    if (groups.length === 1) {
      const date = groups[0].scheduledFor.slice(0, 10), time = groups[0].scheduledFor.slice(11, 16) || null;
      if (date !== item.d || time !== item.t) {
        await client.query(`UPDATE content_items SET publish_date = $2, publish_time = $3, updated_at = now() WHERE id = $1`, [itemId, date, time]);
      }
    }
    // No groups means every link is gone: there's no time to set, only the status.
    if (groups.length < 2 && await writeStatus(client, itemId, after, unknown, tz, now, notes)) counts.published++;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  if (groups.length < 2) return;
  // splitContent runs its own transaction, so it follows this one; then each part gets its own status.
  const r = await splitContent(pool, itemId, groups);
  if (!r.ok) return;
  counts.split++;
  const parts = [r.value.kept.id, ...r.value.created.map((c) => c.id)];
  const partLinks = await linksFor(pool, parts);
  for (const id of parts) {
    const own = partLinks.get(id) || [];
    const nets = new Set(own.map((l) => l.network));
    const held = unplaced.some((l) => nets.has(l.network)) ? notes : [];
    if (await writeStatus(pool, id, own, unknown.filter((u) => nets.has(u.split(" ")[0])), tz, now, held)) counts.published++;
  }
}

async function writeLinkChange(db: Db, c: LinkChange, now: Date): Promise<void> {
  const vals: unknown[] = [c.link.metricoolPostId, c.link.network];
  const sets: string[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (c.state !== undefined) {
    set("state", c.state);
    // A revived link (undone in Metricool) is no longer gone.
    set("gone_at", c.state === "gone" ? now : null);
  }
  if (c.scheduledFor !== undefined) set("scheduled_for", c.scheduledFor);
  if (c.detail !== undefined) set("detail", c.detail);
  if (c.publicUrl !== undefined) set("public_url", c.publicUrl);
  if (c.newHash !== undefined) set("text_hash", c.newHash);
  if (!sets.length) return;
  await db.query(`UPDATE metricool_links SET ${sets.join(", ")} WHERE metricool_post_id = $1 AND network = $2`, vals);
}

/** Metricool's text wins; the old caption goes to draft history first so it can be brought back. */
async function replaceCaption(
  db: PoolClient, itemId: string,
  item: { caption: string; caption_mode: "same" | "separate"; captions: Record<string, string>; platforms: string[] },
  edits: LinkChange[], after: Link[], planner: Map<string, PlannerPost>,
): Promise<void> {
  await logDraft(db, itemId, { captionMode: item.caption_mode, caption: item.caption, captions: item.captions || {} }, "metricool-sync");
  if (item.caption_mode === "separate") {
    const captions = { ...(item.captions || {}) };
    for (const c of edits) captions[c.link.network] = c.text!;
    await db.query(`UPDATE content_items SET captions = $2, updated_at = now() WHERE id = $1`, [itemId, captions]);
    return;
  }
  const texts = after.filter((l) => l.state !== "gone").map((l) => [l.network,
    planner.get(l.metricoolPostId)?.networks.find((n) => n.network === l.network)?.text] as const)
    .filter((x): x is readonly [string, string] => x[1] !== undefined);
  if (new Set(texts.map(([, t]) => textHash(t))).size > 1) {
    // One shared caption, but Metricool now holds different text per network. Platforms Metricool
    // doesn't hold keep the old shared caption, so none is left blank.
    const captions = { ...Object.fromEntries((item.platforms || []).map((n) => [n, item.caption])), ...Object.fromEntries(texts) };
    await db.query(`UPDATE content_items SET caption_mode = 'separate', caption = '', captions = $2, updated_at = now() WHERE id = $1`,
      [itemId, captions]);
  } else {
    await db.query(`UPDATE content_items SET caption = $2, updated_at = now() WHERE id = $1`, [itemId, edits[0].text]);
  }
}

/** Writes the post's overall status and note when they differ; true when it just became Published. */
async function writeStatus(
  db: Db, itemId: string, links: Link[], unknown: string[], tz: string, now: Date, extra: string[] = [],
): Promise<boolean> {
  if (!links.length) return false;  // never touch a post with no links
  const cur = (await db.query(`SELECT status, publish_check FROM content_items WHERE id = $1`, [itemId])).rows[0];
  if (!cur) return false;
  // The day it went, not today, so the note doesn't change on every later run.
  const goneDays = links.filter((l) => l.state === "gone" && l.goneAt).map((l) => localDateIn(tz, new Date(l.goneAt!))).sort();
  const o = overallStatus(links.map((l) => ({ state: l.state, network: l.network, detail: l.detail })),
    goneDays[goneDays.length - 1] || localDateIn(tz, now));
  const note = [o.note, ...unknown.map((u) => `Couldn't read Metricool (${u}).`), ...extra].filter(Boolean).join(" ");
  // A Published post never goes back, and Cancelled is the team's call.
  const status = cur.status === "published" || cur.status === "cancelled" ? cur.status : o.status;
  if (status === cur.status && note === cur.publish_check) return false;
  await db.query(`UPDATE content_items SET status = $2, publish_check = $3, updated_at = now() WHERE id = $1`, [itemId, status, note]);
  return status === "published" && cur.status !== "published";
}
