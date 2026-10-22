// A post marked Scheduled by hand (no Metricool link) becomes Published once
// its time has passed. Posts sent to Metricool are left to the Metricool sync,
// which reads each platform's state from the planner.
import { Pool } from "pg";
import { getSetting } from "../settings";
import { DEFAULT_TZ, localDateIn } from "../dates";

export async function checkPublished(pool: Pool, now = new Date()): Promise<{ published: number }> {
  const tz = (await getSetting(pool, "default_timezone")) || DEFAULT_TZ;
  const today = localDateIn(tz, now);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const items = (await pool.query(
    `SELECT id, publish_date::text AS d, to_char(publish_time, 'HH24:MI') AS t FROM content_items c
      WHERE status = 'scheduled' AND publish_date IS NOT NULL AND publish_date <= $1
        AND NOT EXISTS (SELECT 1 FROM metricool_links l WHERE l.content_item_id = c.id)`, [today])).rows
    // A post with no time is due once its day is over.
    .filter((r) => r.d < today || (r.t && r.t <= clock));
  if (!items.length) return { published: 0 };
  await pool.query(
    "UPDATE content_items SET status = 'published', publish_check = '', updated_at = now() WHERE id = ANY($1)", [items.map((i) => i.id)]);
  return { published: items.length };
}
