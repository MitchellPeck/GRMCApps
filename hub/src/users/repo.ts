import { pool } from "../db";
import type { UserRecord } from "./login-decision";

const USER_COLUMNS = `id, email, name, google_sub, active, is_admin`;

export async function findBySub(sub: string): Promise<UserRecord | null> {
  const r = await pool.query<UserRecord>(
    `SELECT ${USER_COLUMNS} FROM users WHERE google_sub = $1`,
    [sub]
  );
  return r.rows[0] ?? null;
}

// `normalized` must already be lower-cased: this matches users_email_lower_idx.
export async function findByEmail(normalized: string): Promise<UserRecord | null> {
  const r = await pool.query<UserRecord>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1`,
    [normalized]
  );
  return r.rows[0] ?? null;
}

// An invited account's first sign-in: claim the Google identity and take
// Google's name, which overwrites whatever the administrator typed.
export async function bindGoogleIdentity(
  userId: string,
  sub: string,
  email: string,
  name: string | null
): Promise<void> {
  await pool.query(
    `UPDATE users
        SET google_sub = $2, email = $3, name = COALESCE($4, name), last_login = now()
      WHERE id = $1`,
    [userId, sub, email, name]
  );
}

export async function touchLogin(
  userId: string,
  email: string,
  name: string | null
): Promise<void> {
  await pool.query(
    `UPDATE users SET email = $2, name = COALESCE($3, name), last_login = now() WHERE id = $1`,
    [userId, email, name]
  );
}

export interface VerifyContext {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
  user_active: boolean;
  app_id: string | null;
  app_enabled: boolean | null;
  has_grant: boolean;
}

// ONE query on the gateway hot path: every request to every app passes through
// /auth/verify, so identity, app lookup and the grant check are joined rather
// than issued as three round trips. A LEFT JOIN on apps means an unknown
// subdomain yields a row with a null app_id instead of no row at all, which
// keeps "unknown user" and "unknown app" distinguishable.
export async function loadVerifyContext(
  userId: string,
  subdomain: string
): Promise<VerifyContext | null> {
  const r = await pool.query<VerifyContext>(
    `SELECT u.id, u.email, u.name, u.is_admin,
            u.active                   AS user_active,
            a.id                       AS app_id,
            a.enabled                  AS app_enabled,
            (ua.user_id IS NOT NULL)   AS has_grant
       FROM users u
       LEFT JOIN apps a ON a.subdomain = $2
       LEFT JOIN user_app_access ua ON ua.user_id = u.id AND ua.app_id = a.id
      WHERE u.id = $1`,
    [userId, subdomain]
  );
  return r.rows[0] ?? null;
}
