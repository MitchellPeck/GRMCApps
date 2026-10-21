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
  recording_status    text NOT NULL DEFAULT 'idle',
  recording_error     text NOT NULL DEFAULT '',
  speaker_map         jsonb NOT NULL DEFAULT '{}',
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
  id                 bigserial PRIMARY KEY,
  meeting_id         bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  position           integer NOT NULL DEFAULT 0,
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'pending',
  notes              text NOT NULL DEFAULT '',
  transcript         text NOT NULL DEFAULT '',
  transcript_segments jsonb NOT NULL DEFAULT '[]',
  speaker_map        jsonb NOT NULL DEFAULT '{}',
  summary            text NOT NULL DEFAULT '',
  action_items       jsonb NOT NULL DEFAULT '[]',
  transcribe_status  text NOT NULL DEFAULT 'idle',
  transcribe_error   text NOT NULL DEFAULT '',
  transcribe_started_at  timestamptz,
  transcribe_finished_at timestamptz,
  transcript_source  text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Migrate existing installs to the diarization + action-item columns.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcript_segments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS speaker_map jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS action_items jsonb NOT NULL DEFAULT '[]';

-- Migrate existing installs to asynchronous transcription.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcribe_status text NOT NULL DEFAULT 'idle';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcribe_error text NOT NULL DEFAULT '';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcribe_started_at timestamptz;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcribe_finished_at timestamptz;

-- Migrate existing installs to whole-meeting recording.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_status text NOT NULL DEFAULT 'idle';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_error text NOT NULL DEFAULT '';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_map jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcript_source text NOT NULL DEFAULT '';

-- One or more people presenting a given agenda item.
CREATE TABLE IF NOT EXISTS agenda_item_presenters (
  item_id     bigint NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  person_id   bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, person_id)
);

-- Every audio recording ever attached to an agenda item. Files live on the
-- minutesdata volume; rows are never deleted except by cascade, so a recording
-- stays downloadable and re-transcribable for the life of the meeting.
CREATE TABLE IF NOT EXISTS item_recordings (
  id            bigserial PRIMARY KEY,
  item_id       bigint NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  file_name     text NOT NULL DEFAULT '',
  mime_type     text NOT NULL DEFAULT '',
  byte_size     bigint NOT NULL DEFAULT 0,
  storage_path  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS item_recordings_item_idx ON item_recordings (item_id, id);

-- One audio file per whole-meeting recording session. Chunks are appended as
-- they arrive; files live on the minutesdata volume and are removed only when
-- the meeting is deleted.
CREATE TABLE IF NOT EXISTS meeting_recordings (
  id            bigserial PRIMARY KEY,
  meeting_id    bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  mime_type     text NOT NULL DEFAULT '',
  byte_size     bigint NOT NULL DEFAULT 0,
  storage_path  text NOT NULL DEFAULT '',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS meeting_recordings_meeting_idx ON meeting_recordings (meeting_id, id);

-- Topic switches observed while recording: "at second N the meeting moved to
-- item X". Processing turns these into per-item audio windows.
CREATE TABLE IF NOT EXISTS topic_markers (
  id            bigserial PRIMARY KEY,
  recording_id  bigint NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
  item_id       bigint NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  at_seconds    double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS topic_markers_recording_idx ON topic_markers (recording_id, at_seconds);

CREATE INDEX IF NOT EXISTS agenda_items_meeting_idx ON agenda_items (meeting_id, position);

-- Summaries and the report are produced on the server, so they finish whether
-- or not anyone still has the meeting open.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS summarize_status text NOT NULL DEFAULT 'idle';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS summarize_error text NOT NULL DEFAULT '';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS report_status text NOT NULL DEFAULT 'idle';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS report_error text NOT NULL DEFAULT '';
-- Fingerprints of what the saved report was built from (see report.ts).
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS report_sources jsonb NOT NULL DEFAULT '{}';

-- When the report text last changed: written, or edited by hand or by chat.
-- Later than report_generated_at means the minutes have been edited.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS report_updated_at timestamptz;

-- The recording a topic's transcript_segments are timed against: a
-- meeting_recordings id for whole-meeting topics, an item_recordings id
-- otherwise. NULL for topics transcribed before it was kept.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS transcript_recording_id bigint;

-- Bulk changes to a meeting (fix a name everywhere, a speaker rename, later
-- chat edits), with the fields they touched before and after, so each can be
-- undone while nothing else has changed those fields since.
CREATE TABLE IF NOT EXISTS meeting_changes (
  id          bigserial PRIMARY KEY,
  meeting_id  bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  summary     text NOT NULL,
  before      jsonb NOT NULL,
  after       jsonb NOT NULL,
  undone_at   timestamptz,
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_changes_meeting_idx ON meeting_changes (meeting_id, id);
-- What a change was asked to do (for a fix: from, to, itemId), so it can be
-- applied again to a fresh transcription.
ALTER TABLE meeting_changes ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}';
-- The tabs a lock holder has the meeting open in (see locks.ts).
CREATE TABLE IF NOT EXISTS meeting_lock_tabs (
  meeting_id  bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  tab         text NOT NULL,
  email       text NOT NULL,
  seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, tab)
);

-- Who is editing a meeting right now (see locks.ts). One row per meeting.
CREATE TABLE IF NOT EXISTS meeting_locks (
  meeting_id   bigint PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  email        text NOT NULL,
  name         text NOT NULL DEFAULT '',
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz NOT NULL DEFAULT now()
);

-- The chat with a meeting (chatStore.ts). content is json, not jsonb, so it
-- replays exactly as the API returned it.
CREATE TABLE IF NOT EXISTS chat_messages (
  id          bigserial PRIMARY KEY,
  meeting_id  bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  role        text NOT NULL,
  content     json NOT NULL,
  cards       json NOT NULL DEFAULT '[]',
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_meeting_idx ON chat_messages (meeting_id, id);
-- "Start over" sets a conversation aside rather than deleting it.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- People at one meeting who are not in the library: visitors, speakers.
-- Guests are present by definition.
CREATE TABLE IF NOT EXISTS meeting_guests (
  id          bigserial PRIMARY KEY,
  meeting_id  bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  name        text NOT NULL,
  title       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_guests_meeting_idx ON meeting_guests (meeting_id, id);

-- Guests presenting a given agenda item, alongside library presenters.
CREATE TABLE IF NOT EXISTS agenda_item_guest_presenters (
  item_id     bigint NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  guest_id    bigint NOT NULL REFERENCES meeting_guests(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, guest_id)
);

-- Google Drive access per signed-in user, for "Open in Google Docs". The
-- drive.file scope only reaches files this app created.
CREATE TABLE IF NOT EXISTS google_tokens (
  email          text PRIMARY KEY,
  refresh_token  text NOT NULL,
  access_token   text NOT NULL DEFAULT '',
  expires_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The Doc last exported from each user's copy of a report, so opening it again
-- does not make a duplicate until the report is regenerated.
CREATE TABLE IF NOT EXISTS report_docs (
  meeting_id    bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  email         text NOT NULL,
  doc_url       text NOT NULL,
  report_at     timestamptz NOT NULL,
  PRIMARY KEY (meeting_id, email)
);
`;
