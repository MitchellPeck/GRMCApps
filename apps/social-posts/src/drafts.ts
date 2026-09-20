import { Pool } from "pg";
import { draftScheduleDate } from "./dates";
import { referenceDate } from "./schedule";

export async function savePostDrafts(
  pool: Pool, run: string, postDate: string, posts: Record<string, string>, createdBy: string
): Promise<void> {
  for (const key of Object.keys(posts)) {
    await pool.query(
      `INSERT INTO post_drafts (run, post_date, key, text, status, created_by)
       VALUES ($1,$2,$3,$4,'draft',$5)`,
      [run, postDate, key, posts[key], createdBy]
    );
  }
}

export interface DraftRow {
  dateDrafted: string; run: string; postDate: string; key: string; text: string; status: string; createdBy: string;
  /** A weekday key resolved inside the current week, or the draft's own date. */
  scheduleDate: string;
}
export async function getRecentDrafts(pool: Pool): Promise<{ ok: true; rows: DraftRow[] } | { ok: false; error: string }> {
  try {
    const r = await pool.query("SELECT * FROM post_drafts ORDER BY id DESC LIMIT 20");
    const ref = await referenceDate(pool);
    const rows = r.rows.map((row) => ({
      dateDrafted: String(row.created_at), run: row.run, postDate: row.post_date,
      key: row.key, text: row.text, status: row.status, createdBy: row.created_by,
      scheduleDate: draftScheduleDate(row.key, row.post_date, ref),
    }));
    return { ok: true, rows };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
