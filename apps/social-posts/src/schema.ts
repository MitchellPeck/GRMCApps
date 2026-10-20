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

CREATE TABLE IF NOT EXISTS metricool_sends (
  id                bigserial PRIMARY KEY,
  source_type       text NOT NULL DEFAULT '',
  source_ref        text NOT NULL DEFAULT '',
  text              text NOT NULL,
  networks          text NOT NULL,
  image_ref         text NOT NULL DEFAULT '',
  r2_url            text NOT NULL DEFAULT '',
  scheduled_for     text NOT NULL,
  timezone          text NOT NULL,
  metricool_post_id text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'sent',
  error             text NOT NULL DEFAULT '',
  created_by        text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Content pipeline (docs/superpowers/specs/2026-10-20-content-pipeline-design.md).
-- Purely additive: nothing above is altered. Dates are plain calendar dates so
-- a post never slides a day through a timezone conversion.
CREATE TABLE IF NOT EXISTS events (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'event' CHECK (kind IN ('event','department','series')),
  color       text NOT NULL DEFAULT '#092D3E',
  start_date  date,
  end_date    date,
  series_id   text UNIQUE REFERENCES series(id) ON DELETE SET NULL,
  owner_email text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_items (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title           text NOT NULL,
  event_id        text REFERENCES events(id) ON DELETE SET NULL,
  platforms       text[] NOT NULL DEFAULT '{}',
  publish_date    date,
  publish_time    time,
  status          text NOT NULL DEFAULT 'idea'
                  CHECK (status IN ('idea','planned','drafted','ready','scheduled','published','cancelled')),
  owner_email     text NOT NULL DEFAULT '',
  brief           text NOT NULL DEFAULT '',
  caption         text NOT NULL DEFAULT '',
  no_media_needed boolean NOT NULL DEFAULT false,
  series_id       text,
  post_idx        integer,
  draft_id        bigint REFERENCES post_drafts(id) ON DELETE SET NULL,
  draft_key       text NOT NULL DEFAULT '',
  created_by      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, post_idx),
  FOREIGN KEY (series_id, post_idx) REFERENCES series_posts(series_id, post_idx) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS content_items_publish_date_idx ON content_items (publish_date);
CREATE INDEX IF NOT EXISTS content_items_event_idx ON content_items (event_id);
CREATE INDEX IF NOT EXISTS content_items_status_idx ON content_items (status);

CREATE TABLE IF NOT EXISTS media_assets (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  content_item_id text NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  description     text NOT NULL,
  type            text NOT NULL DEFAULT 'photo'
                  CHECK (type IN ('photo','video','graphic','audio','interview','other')),
  gather_date     date,
  gather_location text NOT NULL DEFAULT '',
  assignee_email  text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'needed' CHECK (status IN ('needed','scheduled','captured','edited')),
  file_link       text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Recurring posts: a template plus a repeat rule. The generator turns each
-- occurrence into an ordinary content item, so instances get their own media,
-- owner and status. Written as ALTERs so a database that already has the
-- pipeline tables picks the new columns up too.
CREATE TABLE IF NOT EXISTS recurrences (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title           text NOT NULL,
  brief           text NOT NULL DEFAULT '',
  event_id        text REFERENCES events(id) ON DELETE SET NULL,
  platforms       text[] NOT NULL DEFAULT '{}',
  publish_time    time,
  owner_email     text NOT NULL DEFAULT '',
  no_media_needed boolean NOT NULL DEFAULT false,
  media_template  jsonb NOT NULL DEFAULT '[]',
  draft_key       text NOT NULL DEFAULT '',
  freq            text NOT NULL CHECK (freq IN ('weekly','monthly_date','monthly_weekday')),
  every           integer NOT NULL DEFAULT 1 CHECK (every >= 1),
  weekdays        integer[] NOT NULL DEFAULT '{}',
  month_day       integer,
  nth             integer,
  weekday         integer,
  start_date      date NOT NULL,
  end_date        date,
  max_count       integer,
  active          boolean NOT NULL DEFAULT true,
  created_by      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS recurrence_id text REFERENCES recurrences(id) ON DELETE SET NULL;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS occurrence_date date;
-- Set when one occurrence is edited on its own, so series-wide edits leave it be.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS detached boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS content_items_occurrence_idx ON content_items (recurrence_id, occurrence_date);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS from_template boolean NOT NULL DEFAULT false;

-- One caption for every platform, or a separate one each ({"instagram": "..."}).
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS caption_mode text NOT NULL DEFAULT 'same';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS captions jsonb NOT NULL DEFAULT '{}';
-- A finished file picked from the Approvals app (its id there, and its title
-- at the time, so the row still reads sensibly if Approvals is unreachable).
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS approval_id integer;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS approval_title text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS media_assets_gather_date_idx ON media_assets (gather_date);
CREATE INDEX IF NOT EXISTS media_assets_item_idx ON media_assets (content_item_id);
CREATE INDEX IF NOT EXISTS media_assets_status_idx ON media_assets (status);

-- Drafting profiles (docs/superpowers/specs/2026-10-20-pipeline-as-main-app-design.md):
-- an event's profile, and the overrides a recurring post or a post may carry.
ALTER TABLE events ADD COLUMN IF NOT EXISTS drafting jsonb NOT NULL DEFAULT '{}';
ALTER TABLE recurrences ADD COLUMN IF NOT EXISTS drafting jsonb NOT NULL DEFAULT '{}';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS drafting jsonb NOT NULL DEFAULT '{}';
-- The source item a post was drafted from (a campaign, an episode, or pasted text).
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS source_ref jsonb;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT '';
-- Draft history: which post a draft belongs to.
ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS content_item_id text;
CREATE INDEX IF NOT EXISTS post_drafts_item_idx ON post_drafts (content_item_id);

-- A file uploaded straight to a media item (stored in R2; file_link is its URL).
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS file_name text NOT NULL DEFAULT '';
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS file_type text NOT NULL DEFAULT '';
`;
