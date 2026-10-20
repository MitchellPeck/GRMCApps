// Where the existing drafting tools meet the pipeline: the one-time backfill,
// the series hooks, and the hook that lands each automated run's drafts as
// content items. The drafting logic itself is untouched; only its output is
// also recorded here.
import { Pool, PoolClient } from "pg";
import { suggestDate } from "../dates";
import { getSetting } from "../settings";
import { DEFAULT_PLATFORMS, RUN_EVENTS } from "./config";
import { nextEventColor } from "./repo";
import { seriesStatusToPipeline } from "./rules";

type Db = Pool | PoolClient;

export const BACKFILL_SETTING = "pipeline_backfill_v1";

export async function ensureRunEvents(db: Db): Promise<void> {
  for (const run of Object.values(RUN_EVENTS)) {
    await db.query(
      `INSERT INTO events (id, name, kind, color) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [run.id, run.name, run.kind, run.color],
    );
  }
}

/** The event standing for a series, created on first use. */
export async function ensureSeriesEvent(db: Db, seriesId: string): Promise<string | null> {
  const existing = await db.query("SELECT id FROM events WHERE series_id = $1", [seriesId]);
  if (existing.rowCount) return existing.rows[0].id;
  const s = await db.query("SELECT name, description, status FROM series WHERE id = $1", [seriesId]);
  if (!s.rowCount) return null;
  const row = s.rows[0];
  const r = await db.query(
    `INSERT INTO events (name, kind, color, series_id, notes, archived)
     VALUES ($1,'series',$2,$3,$4,$5) ON CONFLICT (series_id) DO NOTHING RETURNING id`,
    [row.name, await nextEventColor(db), seriesId, row.description || "", row.status === "complete"],
  );
  if (r.rowCount) return r.rows[0].id;
  return (await db.query("SELECT id FROM events WHERE series_id = $1", [seriesId])).rows[0].id;
}

/**
 * Give every post in a series a content item, leaving ones that already have
 * one alone. The year-less "Aug 5" label resolves the same way the Series tab's
 * Metricool button always has.
 */
export async function syncSeriesPosts(db: Db, seriesId: string, refDate: string, createdBy: string): Promise<number> {
  const eventId = await ensureSeriesEvent(db, seriesId);
  if (!eventId) return 0;
  const posts = await db.query("SELECT * FROM series_posts WHERE series_id = $1 ORDER BY post_idx", [seriesId]);
  let created = 0;
  for (const p of posts.rows) {
    const publishDate = suggestDate({ kind: "seriesDate", label: p.date }, refDate) || null;
    const r = await db.query(
      `INSERT INTO content_items (title, event_id, platforms, publish_date, status, brief, caption,
                                  series_id, post_idx, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (series_id, post_idx) DO NOTHING`,
      [p.title, eventId, DEFAULT_PLATFORMS, publishDate, seriesStatusToPipeline(p.status), p.sub || "",
       p.draft || "", seriesId, p.post_idx, createdBy],
    );
    created += r.rowCount || 0;
  }
  return created;
}

export interface BackfillReport { seriesEvents: number; items: number }

/** Events for every series and items for every series post. Idempotent. */
export async function backfill(db: Db, refDate: string): Promise<BackfillReport> {
  await ensureRunEvents(db);
  const before = Number((await db.query("SELECT count(*) AS n FROM events WHERE series_id IS NOT NULL")).rows[0].n);
  const series = await db.query("SELECT id FROM series ORDER BY created_at");
  let items = 0;
  for (const s of series.rows) items += await syncSeriesPosts(db, s.id, refDate, "backfill");
  const after = Number((await db.query("SELECT count(*) AS n FROM events WHERE series_id IS NOT NULL")).rows[0].n);
  return { seriesEvents: after - before, items };
}

/**
 * Run the backfill once per database, in a transaction. After it has run,
 * series created later are synced by the series hooks instead — so a post
 * someone deliberately deletes from the pipeline doesn't reappear on reboot.
 */
export async function backfillOnce(pool: Pool, refDate: string): Promise<BackfillReport | null> {
  const client = await pool.connect();
  try {
    await ensureRunEvents(client);
    if (await getSetting(pool, BACKFILL_SETTING)) return null;
    await client.query("BEGIN");
    const report = await backfill(client, refDate);
    await client.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [BACKFILL_SETTING, new Date().toISOString()],
    );
    await client.query("COMMIT");
    return report;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Metricool accepted the post: it is now queued in the platform's scheduler,
 * so the item is Scheduled for the time it was actually booked. Bookkeeping of
 * a fact, so it skips the Ready gate; a Published item stays Published.
 */
export async function markSentToMetricool(db: Db, contentItemId: string, dateTime: string): Promise<void> {
  const [date, time] = (dateTime || "").split("T");
  const r = await db.query(
    `UPDATE content_items
        SET status = CASE WHEN status IN ('published','cancelled') THEN status ELSE 'scheduled' END,
            publish_date = COALESCE($2::date, publish_date),
            publish_time = COALESCE($3::time, publish_time),
            updated_at = now()
      WHERE id = $1`,
    [contentItemId, /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : null, /^\d{2}:\d{2}/.test(time || "") ? time.slice(0, 5) : null],
  );
}

