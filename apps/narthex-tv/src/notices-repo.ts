import { Pool } from "pg";
import { NoticeText } from "./notices";

export interface NoticeRow {
  id: number;
  headline: string;
  body: string;
  footnote: string;
  theme: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  media_id: number | null;
  media_status: string | null;
  media_error: string | null;
}

const SELECT = `SELECT n.id, n.headline, n.body, n.footnote, n.theme, n.created_by,
                       n.created_at, n.updated_at,
                       m.id AS media_id, m.status AS media_status, m.error AS media_error
                  FROM notices n LEFT JOIN media m ON m.notice_id = n.id`;

export async function listNotices(pool: Pool): Promise<NoticeRow[]> {
  const r = await pool.query<NoticeRow>(`${SELECT} ORDER BY n.id DESC`);
  return r.rows;
}

export async function getNotice(pool: Pool, id: number): Promise<NoticeRow | null> {
  const r = await pool.query<NoticeRow>(`${SELECT} WHERE n.id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function createNotice(
  pool: Pool,
  text: NoticeText,
  theme: string,
  createdBy: string
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO notices (headline, body, footnote, theme, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [text.headline, text.body, text.footnote, theme, createdBy]
  );
  return Number(r.rows[0].id);
}

export async function updateNotice(
  pool: Pool,
  id: number,
  text: NoticeText,
  theme: string
): Promise<void> {
  await pool.query(
    `UPDATE notices SET headline = $2, body = $3, footnote = $4, theme = $5,
                        updated_at = now()
      WHERE id = $1`,
    [id, text.headline, text.body, text.footnote, theme]
  );
}

export async function deleteNotice(pool: Pool, id: number): Promise<boolean> {
  // The media row cascades, and with it every playlist item pointing at it.
  const r = await pool.query("DELETE FROM notices WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}

export const noticeText = (row: NoticeRow): NoticeText => ({
  headline: row.headline,
  body: row.body,
  footnote: row.footnote,
});
