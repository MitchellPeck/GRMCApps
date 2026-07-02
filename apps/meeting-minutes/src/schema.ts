// DDL run on boot (idempotent). Mirrors the design spec data model.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The reusable library of people who may attend or present at meetings.
CREATE TABLE IF NOT EXISTS people (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL DEFAULT '',
  title       text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- An event / meeting.
CREATE TABLE IF NOT EXISTS meetings (
  id                  bigserial PRIMARY KEY,
  title               text NOT NULL,
  meeting_date        text NOT NULL DEFAULT '',
  location            text NOT NULL DEFAULT '',
  description         text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'draft',
  agenda_file_name    text NOT NULL DEFAULT '',
  report              text NOT NULL DEFAULT '',
  report_generated_at timestamptz,
  created_by_email    text NOT NULL DEFAULT '',
  created_by_name     text NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Which people from the library are present for a given meeting.
CREATE TABLE IF NOT EXISTS meeting_attendees (
  meeting_id  bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  person_id   bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, person_id)
);

-- Agenda line items, ordered by position. Each carries typed notes, an AI
-- transcript, and an AI summary.
CREATE TABLE IF NOT EXISTS agenda_items (
  id          bigserial PRIMARY KEY,
  meeting_id  bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  position    integer NOT NULL DEFAULT 0,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending',
  notes       text NOT NULL DEFAULT '',
  transcript  text NOT NULL DEFAULT '',
  summary     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One or more people presenting a given agenda item.
CREATE TABLE IF NOT EXISTS agenda_item_presenters (
  item_id     bigint NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  person_id   bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, person_id)
);

CREATE INDEX IF NOT EXISTS agenda_items_meeting_idx ON agenda_items (meeting_id, position);
`;
