import { Pool } from "pg";
import { PermissionRow } from "./permissions";

export const BOOTSTRAP_ADMIN_EMAIL = "mitchell.peck@graceresurrection.org";

const COLUMNS = `email, name, can_upload, can_schedule, can_manage, is_admin`;

const norm = (email: string) => email.trim().toLowerCase();

export async function getPermissionRow(
  pool: Pool,
  email: string
): Promise<PermissionRow | null> {
  const r = await pool.query<PermissionRow>(
    `SELECT ${COLUMNS} FROM app_users WHERE email = $1`,
    [norm(email)]
  );
  return r.rows[0] ?? null;
}

export async function listPermissionRows(pool: Pool): Promise<PermissionRow[]> {
  const r = await pool.query<PermissionRow>(
    `SELECT ${COLUMNS} FROM app_users ORDER BY is_admin DESC, email`
  );
  return r.rows;
}

export interface PermissionFields {
  name?: string;
  can_upload?: boolean;
  can_schedule?: boolean;
  can_manage?: boolean;
  is_admin?: boolean;
}

// COALESCE on every field so a partial update leaves the rest alone — the admin
// matrix sends one flag at a time as each checkbox is toggled.
export async function upsertPermissionRow(
  pool: Pool,
  email: string,
  f: PermissionFields
): Promise<void> {
  await pool.query(
    `INSERT INTO app_users (email, name, can_upload, can_schedule, can_manage, is_admin)
     VALUES ($1, COALESCE($2, ''), COALESCE($3, false), COALESCE($4, false),
             COALESCE($5, false), COALESCE($6, false))
     ON CONFLICT (email) DO UPDATE SET
       name         = COALESCE($2, app_users.name),
       can_upload   = COALESCE($3, app_users.can_upload),
       can_schedule = COALESCE($4, app_users.can_schedule),
       can_manage   = COALESCE($5, app_users.can_manage),
       is_admin     = COALESCE($6, app_users.is_admin),
       updated_at   = now()`,
    [
      norm(email),
      f.name ?? null,
      f.can_upload ?? null,
      f.can_schedule ?? null,
      f.can_manage ?? null,
      f.is_admin ?? null,
    ]
  );
}

export async function removePermissionRow(pool: Pool, email: string): Promise<boolean> {
  const r = await pool.query("DELETE FROM app_users WHERE email = $1 RETURNING email", [
    norm(email),
  ]);
  return r.rowCount !== null && r.rowCount > 0;
}

// Fires on a fresh database and after a disaster. A no-op whenever any admin
// exists, so a deliberate change stays made. Same shape as the hub's repair.
//
// The bootstrap row gets every permission, not just admin: on a fresh database
// it is the only account, and an admin who cannot schedule cannot set the TV up.
export async function ensureNarthexAdmin(
  pool: Pool,
  log: { info(msg: string): void }
): Promise<void> {
  const c = await pool.query("SELECT count(*)::int AS n FROM app_users WHERE is_admin = true");
  if ((c.rows[0]?.n ?? 0) > 0) return;

  await pool.query(
    `INSERT INTO app_users (email, is_admin, can_upload, can_schedule, can_manage)
     VALUES ($1, true, true, true, true)
     ON CONFLICT (email) DO UPDATE SET is_admin = true`,
    [BOOTSTRAP_ADMIN_EMAIL]
  );
  log.info(`narthex-tv: restored admin on ${BOOTSTRAP_ADMIN_EMAIL}`);
}
