import { pool } from "../db";

export interface AppRow {
  id: string;
  slug: string;
  name: string;
  subdomain: string;
  icon: string | null;
  enabled: boolean;
}

export async function listEnabledApps(): Promise<AppRow[]> {
  const r = await pool.query<AppRow>(
    "SELECT id, slug, name, subdomain, icon, enabled FROM apps WHERE enabled = true ORDER BY name"
  );
  return r.rows;
}

export async function getAppBySubdomain(subdomain: string): Promise<AppRow | null> {
  const r = await pool.query<AppRow>(
    "SELECT id, slug, name, subdomain, icon, enabled FROM apps WHERE subdomain = $1",
    [subdomain]
  );
  return r.rows[0] ?? null;
}

export async function getUser(userId: string): Promise<{ id: string; email: string; name: string | null } | null> {
  const r = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [userId]);
  return r.rows[0] ?? null;
}
