// Where the existing drafting tools meet the pipeline: the one-time backfill,
// the series hooks, and the hook that lands each automated run's drafts as
// content items. The drafting logic itself is untouched; only its output is
// also recorded here.
import { Pool, PoolClient } from "pg";
import { suggestDate } from "../dates";
import { getSetting } from "../settings";
import { DEFAULT_PLATFORMS, RUN_EVENTS } from "./config";
import { getContentRow, nextEventColor, writeBackToSeries } from "./repo";
import { pipelineStatusToSeries, seriesStatusToPipeline } from "./rules";

type Db = Pool | PoolClient;

export const BACKFILL_SETTING = "pipeline_backfill_v1";

export async function ensureRunEvents(db: Db): Promise<void> {
  for (const run of Object.values(RUN_EVENTS)) {
    await db.query(
      `INSERT INTO events (id, name, kind, color) VALUES ($1,$2,'series',$3) ON CONFLICT (id) DO NOTHING`,
      [run.id, run.name, run.color],
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

// ── Series hooks ─────────────────────────────────────────────────────────────

/** A series was renamed, paused or completed: keep its event in step. */
export async function syncSeriesMeta(db: Db, seriesId: string, fields: Record<string, string>): Promise<void> {
  if (fields.name) await db.query("UPDATE events SET name = $1 WHERE series_id = $2", [fields.name, seriesId]);
  if (fields.status) {
    await db.query("UPDATE events SET archived = $1 WHERE series_id = $2", [fields.status === "complete", seriesId]);
  }
}

/**
 * A Series-tab edit to one post field, applied to the post's content item —
 * the record the Series tab now reads from. A legacy status only overrides the
 * item's status when it actually disagrees, so a Ready item isn't knocked back
 * to Drafted because the Series tab only knows "drafted".
 */
export async function applySeriesField(
  db: Db, seriesId: string, postIdx: number, field: string, value: string, refDate: string,
): Promise<void> {
  const r = await db.query("SELECT id FROM content_items WHERE series_id = $1 AND post_idx = $2", [seriesId, postIdx]);
  if (!r.rowCount) return;
  const id = r.rows[0].id;
  const item = await getContentRow(db, id);
  if (!item) return;
  if (field === "status") {
    if (pipelineStatusToSeries(item.status) === value) return;
    await db.query("UPDATE content_items SET status = $1, updated_at = now() WHERE id = $2", [seriesStatusToPipeline(value), id]);
  } else if (field === "draft") {
    await db.query("UPDATE content_items SET caption = $1, updated_at = now() WHERE id = $2", [value, id]);
  } else if (field === "title") {
    await db.query("UPDATE content_items SET title = $1, updated_at = now() WHERE id = $2", [value, id]);
  } else if (field === "sub") {
    await db.query("UPDATE content_items SET brief = $1, updated_at = now() WHERE id = $2", [value, id]);
  } else if (field === "date") {
    const d = suggestDate({ kind: "seriesDate", label: value }, refDate) || null;
    await db.query("UPDATE content_items SET publish_date = $1, updated_at = now() WHERE id = $2", [d, id]);
  }
}

// ── Automated runs ───────────────────────────────────────────────────────────

const OPEN_FOR_REDRAFT = ["idea", "planned", "drafted"];

/**
 * Land a run's drafts in the pipeline as Drafted items under the run's
 * standing event. Re-running the same day refreshes the open item for that
 * slot instead of adding a duplicate; one that has moved on (Ready, Scheduled,
 * Published) is left alone and a fresh item is added beside it.
 */
export async function recordRunDrafts(
  db: Db, run: string,
  drafts: Array<{ key: string; text: string; date: string; draftId: number; title: string }>,
  createdBy: string,
): Promise<Record<string, string>> {
  const event = RUN_EVENTS[run];
  if (!event) return {};
  await ensureRunEvents(db);
  const out: Record<string, string> = {};
  for (const d of drafts) {
    const date = d.date || null;
    const open = await db.query(
      `SELECT id FROM content_items
        WHERE event_id = $1 AND draft_key = $2 AND status = ANY($4)
          AND (publish_date IS NOT DISTINCT FROM $3 OR occurrence_date = $3)
        ORDER BY created_at DESC LIMIT 1`,
      [event.id, d.key, date, OPEN_FOR_REDRAFT],
    );
    if (open.rowCount) {
      const id = open.rows[0].id;
      await db.query(
        `UPDATE content_items SET caption = $1, draft_id = $2, title = $3, status = 'drafted', updated_at = now()
          WHERE id = $4`,
        [d.text, d.draftId, d.title, id],
      );
      out[d.key] = id;
    } else {
      const r = await db.query(
        `INSERT INTO content_items (title, event_id, platforms, publish_date, status, caption, draft_id, draft_key, created_by)
         VALUES ($1,$2,$3,$4,'drafted',$5,$6,$7,$8) RETURNING id`,
        [d.title, event.id, DEFAULT_PLATFORMS, date, d.text, d.draftId, d.key, createdBy],
      );
      out[d.key] = r.rows[0].id;
    }
  }
  return out;
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
  if (!r.rowCount) return;
  const item = await getContentRow(db, contentItemId);
  if (item) await writeBackToSeries(db, item);
}

