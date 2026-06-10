// DDL run on boot (idempotent). Mirrors the spec data model.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS series (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  context     text NOT NULL DEFAULT '',
  cadence     text NOT NULL DEFAULT 'weekly',
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS series_posts (
  series_id  text NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  post_idx   integer NOT NULL,
  date       text NOT NULL DEFAULT '',
  phase      text NOT NULL DEFAULT '',
  title      text NOT NULL,
  sub        text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'pending',
  draft      text NOT NULL DEFAULT '',
  notes      text NOT NULL DEFAULT '',
  PRIMARY KEY (series_id, post_idx)
);

CREATE TABLE IF NOT EXISTS post_drafts (
  id          bigserial PRIMARY KEY,
  run         text NOT NULL,
  post_date   text NOT NULL DEFAULT '',
  key         text NOT NULL,
  text        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
`;
