import { Pool } from "pg";
import { Card } from "./cards-logic";

const norm = (email: string) => email.trim().toLowerCase();

// id::int because node-pg returns bigserial as a string; array_agg with a
// FILTER keeps `additional` an empty array rather than [null] when a card has
// no extra users.
const SELECT_CARDS = `
  SELECT c.id::int AS id, c.last4, c.nickname, c.primary_email, c.active,
         COALESCE(array_agg(cu.email) FILTER (WHERE cu.email IS NOT NULL), '{}') AS additional
    FROM cards c
    LEFT JOIN card_users cu ON cu.card_id = c.id
   GROUP BY c.id
   ORDER BY c.active DESC, c.nickname`;

export async function listCards(pool: Pool): Promise<Card[]> {
  const r = await pool.query<Card>(SELECT_CARDS);
  return r.rows;
}

export async function createCard(
  pool: Pool,
  last4: string,
  nickname: string,
  primaryEmail: string,
  additional: string[]
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "INSERT INTO cards (last4, nickname, primary_email) VALUES ($1, $2, $3) RETURNING id::int AS id",
      [last4, nickname.trim(), norm(primaryEmail)]
    );
    const id: number = r.rows[0].id;
    for (const email of additional) {
      if (!email.trim()) continue;
      await client.query(
        "INSERT INTO card_users (card_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [id, norm(email)]
      );
    }
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface CardFields {
  last4?: string;
  nickname?: string;
  primary_email?: string;
  active?: boolean;
  additional?: string[];
}

export async function updateCard(pool: Pool, id: number, f: CardFields): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE cards SET last4 = COALESCE($2, last4),
                        nickname = COALESCE($3, nickname),
                        primary_email = COALESCE($4, primary_email),
                        active = COALESCE($5, active)
        WHERE id = $1 RETURNING id`,
      [id, f.last4 ?? null, f.nickname ?? null,
       f.primary_email ? norm(f.primary_email) : null, f.active ?? null]
    );
    if (!r.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    // Replaced wholesale when supplied: the UI sends the complete list.
    if (f.additional) {
      await client.query("DELETE FROM card_users WHERE card_id = $1", [id]);
      for (const email of f.additional) {
        if (!email.trim()) continue;
        await client.query(
          "INSERT INTO card_users (card_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [id, norm(email)]
        );
      }
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteCard(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM cards WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}
