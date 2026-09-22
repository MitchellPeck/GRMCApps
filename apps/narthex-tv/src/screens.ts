import { Pool } from "pg";
import { randomBytes } from "node:crypto";

export interface ScreenRow {
  id: number;
  name: string;
  token: string;
  rotation: number;
  enabled: boolean;
  last_seen_at: string | null;
  last_seen_ip: string;
  last_revision: string;
  last_playing: string;
  created_by_email: string;
  created_at: string;
}

const COLUMNS = `id, name, token, rotation, enabled, last_seen_at, last_seen_ip,
                 last_revision, last_playing, created_by_email, created_at`;

// URL-safe, 32 bytes of entropy. This is the only credential the TV has, and it
// travels in a query string on a long-lived kiosk URL, so it is generated here
// and never derived from anything guessable.
export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function listScreens(pool: Pool): Promise<ScreenRow[]> {
  const r = await pool.query<ScreenRow>(`SELECT ${COLUMNS} FROM screens ORDER BY id`);
  return r.rows;
}

export async function createScreen(
  pool: Pool,
  fields: { name: string; rotation?: number; createdByEmail: string }
): Promise<ScreenRow> {
  const r = await pool.query<ScreenRow>(
    `INSERT INTO screens (name, token, rotation, created_by_email)
     VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [fields.name.slice(0, 80), newToken(), normalizeRotation(fields.rotation), fields.createdByEmail]
  );
  return r.rows[0];
}

export function normalizeRotation(value: unknown): number {
  const n = Number(value);
  return [0, 90, 180, 270].includes(n) ? n : 0;
}

export async function updateScreen(
  pool: Pool,
  id: number,
  p: { name?: string; rotation?: number; enabled?: boolean }
): Promise<void> {
  await pool.query(
    `UPDATE screens SET
       name     = COALESCE($2, name),
       rotation = COALESCE($3, rotation),
       enabled  = COALESCE($4, enabled)
     WHERE id = $1`,
    [
      id,
      p.name?.slice(0, 80) ?? null,
      p.rotation === undefined ? null : normalizeRotation(p.rotation),
      p.enabled ?? null,
    ]
  );
}

export async function rotateToken(pool: Pool, id: number): Promise<string | null> {
  const r = await pool.query<{ token: string }>(
    "UPDATE screens SET token = $2 WHERE id = $1 RETURNING token",
    [id, newToken()]
  );
  return r.rows[0]?.token ?? null;
}

export async function deleteScreen(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM screens WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}

export async function findByToken(pool: Pool, token: string): Promise<ScreenRow | null> {
  const value = String(token || "").trim();
  // Reject before touching the database: a screen token is always this shape,
  // and an empty one must never match a row.
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(value)) return null;
  const r = await pool.query<ScreenRow>(
    `SELECT ${COLUMNS} FROM screens WHERE token = $1 AND enabled = true`,
    [value]
  );
  return r.rows[0] ?? null;
}

export async function recordHeartbeat(
  pool: Pool,
  id: number,
  fields: { ip: string; revision: string; playing: string }
): Promise<void> {
  await pool.query(
    `UPDATE screens SET last_seen_at = now(), last_seen_ip = $2,
                        last_revision = $3, last_playing = $4
      WHERE id = $1`,
    [id, fields.ip.slice(0, 64), fields.revision.slice(0, 64), fields.playing.slice(0, 200)]
  );
}
