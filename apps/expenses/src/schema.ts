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

CREATE TABLE IF NOT EXISTS cards (
  id            bigserial PRIMARY KEY,
  last4         text NOT NULL,
  nickname      text NOT NULL,
  primary_email text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Additional authorized users on a card.
CREATE TABLE IF NOT EXISTS card_users (
  card_id bigint NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  email   text NOT NULL,
  PRIMARY KEY (card_id, email)
);

ALTER TABLE requests ADD COLUMN IF NOT EXISTS kind                    text NOT NULL DEFAULT 'post_purchase';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_method          text NOT NULL DEFAULT 'church_card';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS status                  text NOT NULL DEFAULT 'approved';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS card_id                 bigint REFERENCES cards(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS submitted_by_email      text NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS purchased_by_email      text NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approver_email          text NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approval_method         text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approved_at             timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approved_by_email       text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS estimated_amount        numeric(12,2);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS actuals_completed_at    timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS reimbursed_at           timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS reimbursed_by_email     text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS reimbursement_reference text;

CREATE TABLE IF NOT EXISTS receipts (
  id                bigserial PRIMARY KEY,
  request_id        bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  file_name         text NOT NULL,
  mime_type         text NOT NULL,
  byte_size         integer NOT NULL,
  content           bytea NOT NULL,
  uploaded_by_email text NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_events (
  id          bigserial PRIMARY KEY,
  request_id  bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  type        text NOT NULL,
  actor_email text NOT NULL,
  actor_name  text NOT NULL DEFAULT '',
  comment     text NOT NULL DEFAULT '',
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_events_request_idx ON request_events (request_id, created_at);

-- version: bumped by every UPDATE, so a decision made on a stale page is
-- refused rather than applied to numbers the approver never saw.
-- approved_amount: what was last approved, so later corrections are measured
-- against the approval and not against the previous correction.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS version         integer NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approved_amount numeric(12,2);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS voided_at       timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS voided_by_email text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS void_reason     text;

UPDATE requests
   SET approved_amount = CASE WHEN kind = 'pre_purchase' AND actuals_completed_at IS NULL
                              THEN estimated_amount ELSE amount END
 WHERE status = 'approved' AND approved_amount IS NULL;

-- Requests already back for re-approval before this column existed: what was
-- approved is the estimate (actuals path) or the amount before the correction
-- (edit path, kept on the event). Then drop the stale approval they still
-- show — the events keep it.
UPDATE requests r
   SET approved_amount = COALESCE(
         (SELECT (e.meta->>'previousAmount')::numeric FROM request_events e
           WHERE e.request_id = r.id AND e.type = 'reapproval_required'
           ORDER BY e.created_at DESC, e.id DESC LIMIT 1),
         r.estimated_amount, r.amount)
 WHERE r.status = 'pending' AND r.approval_method IS NOT NULL AND r.approved_amount IS NULL;
UPDATE requests
   SET approval_method = NULL, approved_by_email = NULL, approved_at = NULL
 WHERE status = 'pending' AND approval_method IS NOT NULL AND approved_amount IS NOT NULL;

CREATE INDEX IF NOT EXISTS receipts_request_idx  ON receipts (request_id);
CREATE INDEX IF NOT EXISTS requests_status_idx   ON requests (status);
CREATE INDEX IF NOT EXISTS requests_approver_idx ON requests (approver_email);

-- The audit trail is append-only. Deleting stays possible only through the
-- cascade from a request that was never decided (see checkDelete).
CREATE OR REPLACE FUNCTION request_events_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'request_events is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS request_events_no_update ON request_events;
CREATE TRIGGER request_events_no_update BEFORE UPDATE ON request_events
  FOR EACH ROW EXECUTE FUNCTION request_events_no_update();
`;
