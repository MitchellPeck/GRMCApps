// DDL run on boot (idempotent). Mirrors the design spec data model.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS roster (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  email       text UNIQUE NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  id               bigserial PRIMARY KEY,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  submitter_email  text NOT NULL,
  submitter_name   text NOT NULL DEFAULT '',
  approver_email   text NOT NULL,
  approver_name    text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'pending',
  current_version  integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz
);

CREATE TABLE IF NOT EXISTS request_versions (
  request_id        bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  version_no        integer NOT NULL,
  file_name         text NOT NULL,
  mime_type         text NOT NULL,
  byte_size         integer NOT NULL,
  image             bytea NOT NULL,
  note              text NOT NULL DEFAULT '',
  uploaded_by_email text NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, version_no)
);

CREATE TABLE IF NOT EXISTS request_events (
  id           bigserial PRIMARY KEY,
  request_id   bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  version_no   integer NOT NULL,
  type         text NOT NULL,
  actor_email  text NOT NULL,
  actor_name   text NOT NULL DEFAULT '',
  comment      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
`;
