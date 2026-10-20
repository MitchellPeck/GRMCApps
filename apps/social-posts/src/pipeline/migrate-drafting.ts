// Once per database: the weekly runs become drafting profiles carrying their
// prompts word for word, the Saturday invite moves to its own Sunday worship
// event, and each series' Claude context joins its event's notes. Touches no
// post's date, status or caption.
import { Pool } from "pg";
import { RUN_EVENTS } from "./config";
import { ensureRunEvents } from "./sync";
import {
  BLOG_PROFILE, DEFAULT_VOICE, GRACE_NOTES_PROFILE, PODCAST_PROFILE, SERIES_INSTRUCTIONS, SUNDAY_PROFILE,
} from "./drafting-seed";

export const DRAFTING_SETTING = "pipeline_drafting_v1";

export async function migrateDrafting(pool: Pool, today: string): Promise<{ ran: boolean; movedOccurrences: number }> {
  const done = await pool.query("SELECT 1 FROM settings WHERE key = $1", [DRAFTING_SETTING]);
  if (done.rowCount) return { ran: false, movedOccurrences: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO settings (key, value) VALUES ('house_voice', $1) ON CONFLICT (key) DO NOTHING", [DEFAULT_VOICE]);
    await ensureRunEvents(client);
    await client.query(
      "UPDATE events SET name = 'Grace Notes' WHERE id = $1 AND name = 'Grace Notes & Sunday invite'", [RUN_EVENTS.wednesday.id]);
    const seeds: Array<[string, object]> = [
      [RUN_EVENTS.wednesday.id, GRACE_NOTES_PROFILE], [RUN_EVENTS.sunday.id, SUNDAY_PROFILE],
      [RUN_EVENTS.friday.id, BLOG_PROFILE], [RUN_EVENTS.podcast.id, PODCAST_PROFILE],
    ];
    for (const [id, profile] of seeds) {
      await client.query("UPDATE events SET drafting = $2 WHERE id = $1 AND drafting = '{}'::jsonb", [id, profile]);
    }

    // The Saturday invite, and its upcoming posts nobody has started on.
    let moved = 0;
    const sat = await client.query(
      "UPDATE recurrences SET event_id = $1 WHERE draft_key = 'saturday' AND event_id = $2 RETURNING id",
      [RUN_EVENTS.sunday.id, RUN_EVENTS.wednesday.id]);
    for (const r of sat.rows) {
      const m = await client.query(
        `UPDATE content_items SET event_id = $1
          WHERE recurrence_id = $2 AND occurrence_date >= $3 AND NOT detached AND status IN ('idea','planned')`,
        [RUN_EVENTS.sunday.id, r.id, today]);
      moved += m.rowCount || 0;
    }

    // Series context joins the event's notes; series get the series instructions.
    const series = await client.query(
      "SELECT e.id, e.notes, e.drafting, s.context FROM events e JOIN series s ON s.id = e.series_id");
    for (const row of series.rows) {
      const context = (row.context || "").trim();
      const notes = context && !(row.notes || "").includes(context)
        ? [row.notes, context].filter((x: string) => x && x.trim()).join("\n\n") : row.notes;
      const drafting = row.drafting?.instructions ? row.drafting : { ...(row.drafting || {}), instructions: SERIES_INSTRUCTIONS };
      await client.query("UPDATE events SET notes = $2, drafting = $3 WHERE id = $1", [row.id, notes || "", drafting]);
    }

    await client.query("INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())", [DRAFTING_SETTING, new Date().toISOString()]);
    await client.query("COMMIT");
    return { ran: true, movedOccurrences: moved };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
