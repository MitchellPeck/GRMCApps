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
import { Link, linksFor } from "./metricool-links";
import { applyRelink, heldPostIds, refreshIdents, relinkPlan } from "./metricool-relink";
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
  /** Set when Metricool couldn't be read; nothing else changed. */ error?: string;
}

type Db = Pool | PoolClient;
interface Covered { from: string; to: string }

const dayOf = (l: Link) => l.scheduledFor.slice(0, 10);
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
  const counts: SyncCounts = { moved: 0, split: 0, edited: 0, gone: 0, imported: 0, published: 0 };
  // Go-live day: nothing dated before the first sync is ever imported.
  if (!(await getSetting(pool, IMPORT_SINCE_SETTING))) await setSetting(pool, IMPORT_SINCE_SETTING, today);

  const itemIds = o.itemId ? [o.itemId]
    : (await pool.query(`SELECT DISTINCT content_item_id FROM metricool_links WHERE content_item_id IS NOT NULL`)).rows.map((r) => r.content_item_id);
  const links = [...(await linksFor(pool, itemIds)).values()].flat();
  const dates = links.map(dayOf).filter(Boolean).sort();
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
      `UPDATE content_items SET publish_check = $2 WHERE id = ANY($1) AND status <> 'published' AND publish_check <> $2`,
      [[...new Set(ranged.map((l) => l.contentItemId))], "Couldn't check Metricool: " + reason]);
    return { ...counts, error: reason };
  }

  // Follow posts Metricool re-id'd (and sends that never got an id) before anything reads as gone.
  await refreshIdents(pool, ranged, planner);
  const idless = (await idlessSendsForRelink(pool, tz)).filter((s) => !o.itemId || s.itemId === o.itemId);
  const plan = relinkPlan(ranged, planner, idless, await heldPostIds(pool));
  await applyRelink(pool, plan);
  const claimed = new Set(plan.map((e) => e.toPostId));

  const touched = new Set([...ranged.map((l) => l.contentItemId), ...plan.map((e) => e.itemId)]);
  const byId = new Map(planner.map((p) => [p.id, p]));
  for (const [itemId, itemLinks] of await linksFor(pool, [...touched])) {
    await syncItem(pool, itemId, itemLinks, byId, covered, tz, now, counts);
  }

  if (!o.itemId) {
    const linked = await heldPostIds(pool);
    const sent = new Set((await pool.query(
      `SELECT DISTINCT metricool_post_id FROM metricool_sends WHERE metricool_post_id <> ''`)).rows.map((r) => String(r.metricool_post_id)));
    const since = await getSetting(pool, IMPORT_SINCE_SETTING);
    const unsent = await idlessSends(pool);
    for (const p of planner) {
      if (!shouldImport(p, linked, sent, since, unsent, claimed)) continue;
      // One unreadable post mustn't stop the rest; it isn't linked, so the next run tries again.
      try { await importPlannerPost(pool, p, tz); counts.imported++; } catch { /* retried next run */ }
    }
  }
  return counts;
}

async function syncItem(
  pool: Pool, itemId: string, links: Link[], planner: Map<string, PlannerPost>, covered: Covered, tz: string, now: Date,
  counts: SyncCounts,
): Promise<void> {
  const { changes, groups, unknown } = reconcileItem(links, planner, covered);
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
      `SELECT caption, caption_mode, captions, publish_date::text AS d, to_char(publish_time, 'HH24:MI') AS t
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
    if (groups.length < 2 && await writeStatus(client, itemId, after, unknown, tz, now)) counts.published++;
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
    if (await writeStatus(pool, id, own, unknown.filter((u) => nets.has(u.split(" ")[0])), tz, now)) counts.published++;
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
  db: PoolClient, itemId: string, item: { caption: string; caption_mode: "same" | "separate"; captions: Record<string, string> },
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
    // One shared caption, but Metricool now holds different text per network.
    await db.query(`UPDATE content_items SET caption_mode = 'separate', caption = '', captions = $2, updated_at = now() WHERE id = $1`,
      [itemId, Object.fromEntries(texts)]);
  } else {
    await db.query(`UPDATE content_items SET caption = $2, updated_at = now() WHERE id = $1`, [itemId, edits[0].text]);
  }
}

/** Writes the post's overall status and note when they differ; true when it just became Published. */
async function writeStatus(db: Db, itemId: string, links: Link[], unknown: string[], tz: string, now: Date): Promise<boolean> {
  if (!links.length) return false;  // never touch a post with no links
  const cur = (await db.query(`SELECT status, publish_check FROM content_items WHERE id = $1`, [itemId])).rows[0];
  if (!cur) return false;
  // The day it went, not today, so the note doesn't change on every later run.
  const goneDays = links.filter((l) => l.state === "gone" && l.goneAt).map((l) => localDateIn(tz, new Date(l.goneAt!))).sort();
  const o = overallStatus(links.map((l) => ({ state: l.state, network: l.network, detail: l.detail })),
    goneDays[goneDays.length - 1] || localDateIn(tz, now));
  const note = [o.note, ...unknown.map((u) => `Couldn't read Metricool (${u}).`)].filter(Boolean).join(" ");
  // A Published post never goes back, and Cancelled is the team's call.
  const status = cur.status === "published" || cur.status === "cancelled" ? cur.status : o.status;
  if (status === cur.status && note === cur.publish_check) return false;
  await db.query(`UPDATE content_items SET status = $2, publish_check = $3, updated_at = now() WHERE id = $1`, [itemId, status, note]);
  return status === "published" && cur.status !== "published";
}
