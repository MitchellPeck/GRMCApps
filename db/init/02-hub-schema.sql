-- Runs as superuser after 01-databases.sh. Switch into the hub database and
-- create objects owned by the hub role so the app can manage its own data.
-- NOTE: 'hub' must match HUB_DB_NAME in .env. Plain .sql init files don't get
-- shell expansion, so the database name is hardcoded here.
\connect hub
SET ROLE hub_user;

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub  text UNIQUE NOT NULL,
  email       text NOT NULL,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login  timestamptz
);

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

-- Seed the registry with the throwaway validation app.
INSERT INTO apps (slug, name, subdomain, icon)
VALUES ('whoami', 'Who Am I', 'whoami', '👤');

INSERT INTO apps (slug, name, subdomain, icon)
VALUES ('social-posts', 'Social Posts', 'social', '📣');

RESET ROLE;
