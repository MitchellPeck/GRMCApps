import { pool } from "../db";

export interface AppRow {
  id: string;
  slug: string;
  name: string;
  host: string;
  icon: string | null;
  enabled: boolean;
}

export async function listEnabledApps(): Promise<AppRow[]> {
  const r = await pool.query<AppRow>(
    "SELECT id, slug, name, host, icon, enabled FROM apps WHERE enabled = true ORDER BY name"
  );
  return r.rows;
}

export async function getAppByHost(host: string): Promise<AppRow | null> {
  const r = await pool.query<AppRow>(
    "SELECT id, slug, name, host, icon, enabled FROM apps WHERE host = $1",
    [host]
  );
  return r.rows[0] ?? null;
}

export async function getUser(userId: string): Promise<{ id: string; email: string; name: string | null } | null> {
  const r = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [userId]);
  return r.rows[0] ?? null;
}
