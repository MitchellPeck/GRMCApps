// Every Draft with Claude result, kept against its post, so an earlier
// draft can be brought back. Stored in post_drafts (which also holds the old
// runs' drafts) with content_item_id set.
import { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

export interface DraftEntry {
  id: number; at: string; by: string; origin: "claude" | "run";
  captionMode: "same" | "separate"; caption: string; captions: Record<string, string>;
}

export async function logDraft(
  db: Db, contentItemId: string,
  d: { captionMode: "same" | "separate"; caption?: string; captions?: Record<string, string> }, createdBy: string,
): Promise<void> {
  const separate = d.captionMode === "separate";
  await db.query(
    `INSERT INTO post_drafts (run, post_date, key, text, status, created_by, content_item_id)
     VALUES ('pipeline', '', $1, $2, 'draft', $3, $4)`,
    [separate ? "separate" : "all", separate ? JSON.stringify(d.captions || {}) : d.caption || "", createdBy, contentItemId],
  );
}

export async function listDraftHistory(db: Db, contentItemId: string): Promise<DraftEntry[]> {
  const r = await db.query(
    `SELECT * FROM post_drafts
      WHERE content_item_id = $1 OR id = (SELECT draft_id FROM content_items WHERE id = $1)
      ORDER BY id DESC LIMIT 20`,
    [contentItemId],
  );
  return r.rows.map((row) => {
    let captions: Record<string, string> = {};
    if (row.key === "separate") { try { captions = JSON.parse(row.text); } catch { captions = {}; } }
    return {
      id: Number(row.id), at: new Date(row.created_at).toISOString(), by: row.created_by,
      origin: row.run === "pipeline" ? "claude" : "run",
      captionMode: row.key === "separate" ? "separate" : "same",
      caption: row.key === "separate" ? "" : row.text, captions,
    };
  });
}
