import { Pool } from "pg";

// The chat with a meeting, kept exactly as sent and returned. Assistant turns
// carry thinking blocks that must be replayed unchanged, so content is stored
// as `json` (kept as written), not `jsonb` (which reorders keys), and rows are
// only ever appended.

export interface ChatRow {
  id: number;
  role: "user" | "assistant";
  content: unknown[];
  cards: unknown[];
  created_by: string;
  created_at: string;
}

export async function appendChat(
  pool: Pool,
  meetingId: number,
  role: "user" | "assistant",
  content: unknown[],
  cards: unknown[] = [],
  by = ""
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO chat_messages (meeting_id, role, content, cards, created_by)
     VALUES ($1, $2, $3::json, $4::json, $5) RETURNING id`,
    [meetingId, role, JSON.stringify(content), JSON.stringify(cards), by]
  );
  return Number(r.rows[0].id);
}

export async function loadChatHistory(pool: Pool, meetingId: number): Promise<ChatRow[]> {
  const r = await pool.query(
    `SELECT id, role, content::text AS content, cards::text AS cards, created_by, created_at
       FROM chat_messages WHERE meeting_id = $1 ORDER BY id`,
    [meetingId]
  );
  return r.rows.map((row) => ({
    id: Number(row.id), role: row.role, content: JSON.parse(row.content), cards: JSON.parse(row.cards),
    created_by: row.created_by, created_at: row.created_at,
  }));
}
