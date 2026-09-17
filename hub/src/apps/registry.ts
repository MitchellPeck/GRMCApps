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

export interface HubUser {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
  active: boolean;
}

export async function getUser(userId: string): Promise<HubUser | null> {
  const r = await pool.query<HubUser>(
    "SELECT id, email, name, is_admin, active FROM users WHERE id = $1",
    [userId]
  );
  return r.rows[0] ?? null;
}

// Enabled AND granted. The dashboard and the cross-app switcher both use this,
// so the switcher never advertises an app that would answer 403.
export async function listAppsForUser(userId: string): Promise<AppRow[]> {
  const r = await pool.query<AppRow>(
    `SELECT a.id, a.slug, a.name, a.subdomain, a.icon, a.enabled
       FROM apps a
       JOIN user_app_access ua ON ua.app_id = a.id
      WHERE ua.user_id = $1 AND a.enabled = true
      ORDER BY a.name`,
    [userId]
  );
  return r.rows;
}

// Active users only — a disabled account must not appear in any picker.
export async function listActiveUsers(): Promise<HubUser[]> {
  const r = await pool.query<HubUser>(
    `SELECT id, email, name, is_admin, active FROM users
      WHERE active = true ORDER BY lower(COALESCE(name, email))`
  );
  return r.rows;
}

// Users the hub has granted a given app. Apps use this to populate pickers;
// each app remains the authority on what those users may do inside it.
export async function listUsersForApp(slug: string): Promise<HubUser[]> {
  const r = await pool.query<HubUser>(
    `SELECT u.id, u.email, u.name, u.is_admin, u.active
       FROM users u
       JOIN user_app_access ua ON ua.user_id = u.id
       JOIN apps a ON a.id = ua.app_id
      WHERE a.slug = $1 AND u.active = true
      ORDER BY lower(COALESCE(u.name, u.email))`,
    [slug]
  );
  return r.rows;
}
