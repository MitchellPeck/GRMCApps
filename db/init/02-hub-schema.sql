-- Runs as superuser after 01-databases.sh. Switch into the hub database and
-- create objects owned by the hub role so the app can manage its own data.
-- NOTE: 'hub' must match HUB_DB_NAME in .env. Plain .sql init files don't get
-- shell expansion, so the database name is hardcoded here.
\connect hub
SET ROLE hub_user;

-- google_sub is nullable: an invited account has no Google identity until its
-- first sign-in. UNIQUE still holds, because Postgres treats NULLs as distinct.
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub  text UNIQUE,
  email       text NOT NULL,
  name        text,
  is_admin    boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  invited_at  timestamptz NOT NULL DEFAULT now(),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login  timestamptz
);

-- Email is the invite key an administrator types, matched case-insensitively.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE apps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  subdomain   text UNIQUE NOT NULL,
  icon        text,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  sid     text PRIMARY KEY,
  sess    jsonb NOT NULL,
  expire  timestamptz NOT NULL
);
CREATE INDEX session_expire_idx ON session (expire);

-- A row means this user may open this app. Absence means denial. The hub also
-- creates this on boot (see hub/src/users/schema.ts), which is what carries the
-- table onto an ALREADY-PROVISIONED volume this file can never reach.
CREATE TABLE user_app_access (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id     uuid NOT NULL REFERENCES apps(id)  ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, app_id)
);

RESET ROLE;

-- App-registry rows are seeded separately in 03-app-registry.sql, which is
-- idempotent and re-run by the db-init service on every `up` — so adding an app
-- registers it against a LIVE hub DB, not only on a fresh Postgres volume.
