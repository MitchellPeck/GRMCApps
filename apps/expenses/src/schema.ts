// DDL run on boot (idempotent). Mirrors the design spec data model.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Self-referencing: a row with parent_id set is a sub-charge code.
CREATE TABLE IF NOT EXISTS charge_codes (
  id         bigserial PRIMARY KEY,
  code       text NOT NULL,
  label      text NOT NULL,
  parent_id  bigint REFERENCES charge_codes(id) ON DELETE CASCADE,
  sort       integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS charge_codes_code_parent_idx
  ON charge_codes (code, COALESCE(parent_id, 0));

CREATE TABLE IF NOT EXISTS requests (
  id               bigserial PRIMARY KEY,
  request_date     date,
  amount           numeric(12,2) NOT NULL DEFAULT 0,
  reason           text NOT NULL DEFAULT '',
  vendor           text NOT NULL DEFAULT '',
  charge_code      text NOT NULL DEFAULT '',
  sub_charge_code  text NOT NULL DEFAULT '',
  purchased_by     text NOT NULL DEFAULT '',
  card             text NOT NULL DEFAULT '',
  submitted_by     text NOT NULL DEFAULT '',
  approved_by      text NOT NULL DEFAULT '',
  created_by_email text NOT NULL DEFAULT '',
  created_by_name  text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_items (
  request_id bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  idx        integer NOT NULL,
  title      text NOT NULL,
  price      numeric(12,2) NOT NULL DEFAULT 0,
  auto_type  text,
  PRIMARY KEY (request_id, idx)
);

CREATE TABLE IF NOT EXISTS app_users (
  email                  text PRIMARY KEY,
  name                   text NOT NULL DEFAULT '',
  can_submit             boolean NOT NULL DEFAULT false,
  can_submit_for_others  boolean NOT NULL DEFAULT false,
  can_edit_own           boolean NOT NULL DEFAULT false,
  can_approve            boolean NOT NULL DEFAULT false,
  can_manage             boolean NOT NULL DEFAULT false,
  is_admin               boolean NOT NULL DEFAULT false,
  default_approver_email text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
`;
