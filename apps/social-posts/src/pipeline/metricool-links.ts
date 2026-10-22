import { Pool } from "pg";
import type { LinkState } from "../metricool-planner";
import { getSetting, setSetting } from "../settings";

export const LINKS_BACKFILL_SETTING = "metricool_links_backfill";

export interface Link {
  contentItemId: string; metricoolPostId: string; network: string; scheduledFor: string;
  state: LinkState; detail: string; publicUrl: string; textHash: string; goneAt: string | null;
}

export async function linksFor(db: Pool, itemIds: string[]): Promise<Map<string, Link[]>> {
  const out = new Map<string, Link[]>();
  if (!itemIds.length) return out;
  const rows = (await db.query(
    `SELECT * FROM metricool_links WHERE content_item_id = ANY($1) ORDER BY metricool_post_id, network`, [itemIds])).rows;
  for (const r of rows) {
    const list = out.get(r.content_item_id) || [];
    list.push({
      contentItemId: r.content_item_id, metricoolPostId: r.metricool_post_id, network: r.network,
      scheduledFor: r.scheduled_for || "", state: r.state, detail: r.detail || "", publicUrl: r.public_url || "",
      textHash: r.text_hash || "", goneAt: r.gone_at ? new Date(r.gone_at).toISOString() : null,
    });
    out.set(r.content_item_id, list);
  }
  return out;
}

/** Text hash stays empty: the first sync sets the baseline from what Metricool holds. */
export async function addLinks(
  db: Pool, itemId: string, postId: string, networks: string[], scheduledFor: string, state: "draft" | "scheduled",
): Promise<void> {
  for (const network of networks) {
    await db.query(
      `INSERT INTO metricool_links (content_item_id, metricool_post_id, network, scheduled_for, state, last_seen_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (metricool_post_id, network) DO UPDATE
         SET content_item_id = EXCLUDED.content_item_id, scheduled_for = EXCLUDED.scheduled_for,
             state = EXCLUDED.state, gone_at = NULL, last_seen_at = now()`,
      [itemId, postId, network, scheduledFor, state]);
  }
}

export async function hasLiveLinks(db: Pool, itemId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM metricool_links WHERE content_item_id = $1 AND state <> 'gone' LIMIT 1`, [itemId]);
  return r.rows.length > 0;
}

/**
 * One-time: turn the send log into links. A re-send replaces the earlier send, so
 * only the sends within 10 minutes of the newest count (the rule the publish check used).
 */
export async function backfillLinks(db: Pool, _timezone: string): Promise<number> {
  if (await getSetting(db, LINKS_BACKFILL_SETTING)) return 0;
  const sends = (await db.query(
    `SELECT s.source_ref, s.metricool_post_id, s.networks, s.scheduled_for, s.created_at, c.status AS item_status
       FROM metricool_sends s JOIN content_items c ON c.id = s.source_ref
      WHERE s.source_type = 'content' AND s.status = 'sent' AND s.metricool_post_id <> ''`)).rows;
  const byItem = new Map<string, typeof sends>();
  for (const s of sends) byItem.set(s.source_ref, [...(byItem.get(s.source_ref) || []), s]);
  let count = 0;
  for (const [itemId, rows] of byItem) {
    const newest = Math.max(...rows.map((r) => new Date(r.created_at).getTime()));
    for (const s of rows.filter((r) => newest - new Date(r.created_at).getTime() <= 10 * 60 * 1000)) {
      const networks = String(s.networks).split(",").map((n) => n.trim()).filter(Boolean).map((n) => (n === "twitter" ? "x" : n));
      await addLinks(db, itemId, String(s.metricool_post_id), networks, s.scheduled_for, "scheduled");
      if (s.item_status === "published") {
        await db.query(`UPDATE metricool_links SET state = 'published' WHERE metricool_post_id = $1`, [String(s.metricool_post_id)]);
      }
      count += networks.length;
    }
  }
  await setSetting(db, LINKS_BACKFILL_SETTING, new Date().toISOString());
  return count;
}
