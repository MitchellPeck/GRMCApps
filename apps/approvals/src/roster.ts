import { Pool } from "pg";

export interface RosterEntry {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export type AddResult = { ok: true; id: number } | { ok: false; error: string };

// Insert a roster member; on duplicate email, update the name and reactivate.
export async function addRosterEntry(pool: Pool, name: string, email: string): Promise<AddResult> {
  const n = name.trim();
  const e = email.trim().toLowerCase();
  if (!n) return { ok: false, error: "Name is required." };
  if (!e || !e.includes("@")) return { ok: false, error: "A valid email is required." };
  try {
    const r = await pool.query(
      `INSERT INTO roster (name, email, active) VALUES ($1, $2, true)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, active = true
       RETURNING id`,
      [n, e]
    );
    return { ok: true, id: Number(r.rows[0].id) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function listRoster(pool: Pool, includeInactive: boolean): Promise<RosterEntry[]> {
  const where = includeInactive ? "" : "WHERE active = true";
  const r = await pool.query(
    `SELECT id, name, email, active FROM roster ${where} ORDER BY name`
  );
  return r.rows.map((row) => ({
    id: Number(row.id), name: row.name, email: row.email, active: row.active,
  }));
}

export async function getRosterEntry(pool: Pool, id: number): Promise<RosterEntry | null> {
  const r = await pool.query(
    "SELECT id, name, email, active FROM roster WHERE id = $1", [id]
  );
  const row = r.rows[0];
  return row ? { id: Number(row.id), name: row.name, email: row.email, active: row.active } : null;
}

export async function setRosterActive(pool: Pool, id: number, active: boolean): Promise<void> {
  await pool.query("UPDATE roster SET active = $2 WHERE id = $1", [id, active]);
}
