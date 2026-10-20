// Scheduled posts become Published. A post sent through the app is confirmed
// with Metricool (every send for it must have gone out on every network); a
// post marked Scheduled by hand becomes Published once its time has passed.
// A Metricool failure leaves the post Scheduled with the reason on it.
import { Pool } from "pg";
import { getSetting } from "../settings";
import { DEFAULT_TZ, addDays, localDateIn } from "../dates";
import { getMetricoolCreds, listSchedulerPosts, publicationState } from "../metricool";

/** The sends from the latest time a post was sent (a re-send replaces the earlier ones). */
function latestSends(rows: Array<{ id: string; at: Date; date: string }>): Array<{ id: string; date: string }> {
  const newest = Math.max(...rows.map((r) => r.at.getTime()));
  return rows.filter((r) => newest - r.at.getTime() <= 10 * 60 * 1000);
}

export async function checkPublished(pool: Pool, now = new Date()): Promise<{ published: number; failed: number }> {
  const tz = (await getSetting(pool, "default_timezone")) || DEFAULT_TZ;
  const today = localDateIn(tz, now);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const items = (await pool.query(
    `SELECT id, publish_date::text AS d, to_char(publish_time, 'HH24:MI') AS t FROM content_items
      WHERE status = 'scheduled' AND publish_date IS NOT NULL AND publish_date <= $1`, [today])).rows
    // A post with no time is due once its day is over.
    .filter((r) => r.d < today || (r.t && r.t <= clock));
  if (!items.length) return { published: 0, failed: 0 };

  const sends = (await pool.query(
    `SELECT source_ref, metricool_post_id, created_at, left(scheduled_for, 10) AS d FROM metricool_sends
      WHERE source_type = 'content' AND status = 'sent' AND metricool_post_id <> '' AND source_ref = ANY($1)`,
    [items.map((i) => i.id)])).rows;
  const byItem = new Map<string, Array<{ id: string; at: Date; date: string }>>();
  for (const s of sends) {
    const list = byItem.get(s.source_ref) || [];
    list.push({ id: String(s.metricool_post_id), at: new Date(s.created_at), date: s.d });
    byItem.set(s.source_ref, list);
  }

  const set = (id: string, status: string, note: string) =>
    pool.query("UPDATE content_items SET status = $2, publish_check = $3, updated_at = now() WHERE id = $1", [id, status, note]);
  let published = 0, failed = 0;

  // Never sent through the app: its time has passed, so it's out.
  for (const it of items.filter((i) => !byItem.has(i.id))) { await set(it.id, "published", ""); published++; }

  const viaMetricool = items.filter((i) => byItem.has(i.id));
  if (!viaMetricool.length) return { published, failed };
  let planner: Map<string, { providers: any[] }>;
  try {
    const creds = await getMetricoolCreds(pool);
    const dates = viaMetricool.flatMap((i) => latestSends(byItem.get(i.id)!).map((s) => s.date)).filter(Boolean).sort();
    const list = await listSchedulerPosts(creds, addDays(dates[0], -1), addDays(dates[dates.length - 1], 1), tz);
    planner = new Map(list.map((p) => [p.id, p]));
  } catch (e) {
    for (const it of viaMetricool) await set(it.id, "scheduled", "Couldn't check Metricool: " + (e as Error).message);
    return { published, failed };
  }
  for (const it of viaMetricool) {
    const states = latestSends(byItem.get(it.id)!).map((s) => planner.get(s.id) ? publicationState(planner.get(s.id)!) : { state: "unknown", detail: "" });
    const broken = states.filter((s) => s.state === "failed");
    if (broken.length) { await set(it.id, "scheduled", "Metricool couldn't publish it: " + broken.map((s) => s.detail).join("; ")); failed++; }
    else if (states.every((s) => s.state === "published")) { await set(it.id, "published", ""); published++; }
    // Still pending, or Metricool said something we don't recognise: leave it.
  }
  return { published, failed };
}
