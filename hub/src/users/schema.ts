// The first administrator on a fresh database. Hardcoded in the repo by
// design: db/init/*.sql cannot reach an already-provisioned volume, so the hub
// owns this and there is exactly one source of truth.
export const BOOTSTRAP_ADMIN_EMAIL = "mitchell.peck@graceresurrection.org";

// Run on every hub boot. Every statement is a no-op when already applied.
// `google_sub` becomes nullable because an invited account has no Google
// identity until its first sign-in; its UNIQUE constraint stays correct
// because Postgres treats NULLs as distinct.
export const BASE_DDL = `
ALTER TABLE users ALTER COLUMN google_sub DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin   boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active     boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS user_app_access (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id     uuid NOT NULL REFERENCES apps(id)  ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, app_id)
);
`;

export const PROBE_ACCESS_TABLE_SQL = `SELECT to_regclass('public.user_app_access') AS reg`;

// One-time: everyone who could already sign in keeps every app they could
// already open, so nobody is locked out mid-week by the deploy.
export const GRANDFATHER_SQL = `
INSERT INTO user_app_access (user_id, app_id)
SELECT u.id, a.id FROM users u CROSS JOIN apps a
ON CONFLICT DO NOTHING
`;

export const PROMOTE_BOOTSTRAP_SQL = `UPDATE users SET is_admin = true WHERE lower(email) = $1`;

export const COUNT_ACTIVE_ADMINS_SQL = `
SELECT count(*)::int AS n FROM users WHERE is_admin = true AND active = true
`;

export const FIND_BY_LOWER_EMAIL_SQL = `SELECT id FROM users WHERE lower(email) = $1`;

export const INSERT_BOOTSTRAP_SQL = `
INSERT INTO users (email, name, is_admin, active) VALUES ($1, $2, true, true) RETURNING id
`;

export const REPROMOTE_SQL = `UPDATE users SET is_admin = true, active = true WHERE id = $1`;

export const GRANT_ALL_ENABLED_SQL = `
INSERT INTO user_app_access (user_id, app_id)
SELECT $1, a.id FROM apps a WHERE a.enabled = true
ON CONFLICT DO NOTHING
`;
