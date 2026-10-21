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
       FROM chat_messages WHERE meeting_id = $1 AND archived_at IS NULL ORDER BY id`,
    [meetingId]
  );
  return r.rows.map((row) => ({
    id: Number(row.id), role: row.role, content: JSON.parse(row.content), cards: JSON.parse(row.cards),
    created_by: row.created_by, created_at: row.created_at,
  }));
}

// A Confirm card the person pressed: remembered, so it shows as done later.
// Cards are display data (never sent to the model), so marking one is safe.
export async function markCardDone(pool: Pool, meetingId: number, cardId: string): Promise<boolean> {
  const rows = (await pool.query(
    "SELECT id, cards::text AS cards FROM chat_messages WHERE meeting_id = $1 AND cards::text LIKE $2",
    [meetingId, `%${cardId.replace(/[%_\\]/g, "")}%`]
  )).rows;
  for (const row of rows) {
    const cards = JSON.parse(row.cards) as any[];
    const card = cards.find((c) => c.id === cardId);
    if (!card) continue;
    card.done = true;
    await pool.query("UPDATE chat_messages SET cards = $2::json WHERE id = $1", [row.id, JSON.stringify(cards)]);
    return true;
  }
  return false;
}

// "Start over": the conversation so far is set aside (kept, not shown or sent).
export async function archiveChat(pool: Pool, meetingId: number): Promise<void> {
  await pool.query("UPDATE chat_messages SET archived_at = now() WHERE meeting_id = $1 AND archived_at IS NULL", [meetingId]);
}
