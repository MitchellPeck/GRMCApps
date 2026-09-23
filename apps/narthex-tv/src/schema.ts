// DDL run on boot (idempotent), same posture as the other GRMC apps: the app
// owns its schema so it reaches a live database, which db/init/ never can.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  email        text PRIMARY KEY,
  name         text NOT NULL DEFAULT '',
  can_upload   boolean NOT NULL DEFAULT false,
  can_schedule boolean NOT NULL DEFAULT false,
  can_manage   boolean NOT NULL DEFAULT false,
  is_admin     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One uploaded file. 'deck' covers PowerPoint and PDF: both are flattened to
-- one image per slide at ingest, so the player never has to render a document.
CREATE TABLE IF NOT EXISTS media (
  id                bigserial PRIMARY KEY,
  kind              text NOT NULL,                       -- image | video | deck
  title             text NOT NULL DEFAULT '',
  file_name         text NOT NULL DEFAULT '',
  mime_type         text NOT NULL DEFAULT '',
  byte_size         bigint NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending',     -- pending|processing|ready|failed
  error             text NOT NULL DEFAULT '',
  width             integer,
  height            integer,
  duration_ms       integer,                             -- video only, natural length
  page_count        integer NOT NULL DEFAULT 0,          -- deck only
  original_path     text NOT NULL DEFAULT '',
  play_path         text NOT NULL DEFAULT '',            -- image/video the player fetches
  poster_path       text NOT NULL DEFAULT '',
  uploaded_by_email text NOT NULL DEFAULT '',
  uploaded_by_name  text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_status_idx ON media (status, id);

-- One rendered slide of a deck.
CREATE TABLE IF NOT EXISTS media_pages (
  media_id bigint NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  idx      integer NOT NULL,
  path     text NOT NULL,
  PRIMARY KEY (media_id, idx)
);

-- "This group of media items" in the user's words.
CREATE TABLE IF NOT EXISTS playlists (
  id               bigserial PRIMARY KEY,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  image_seconds    integer NOT NULL DEFAULT 0,   -- 0 = inherit the app setting
  slide_seconds    integer NOT NULL DEFAULT 0,   -- 0 = inherit
  transition       text NOT NULL DEFAULT '',     -- '' = inherit | none | fade
  fit              text NOT NULL DEFAULT '',     -- '' = inherit | contain | cover
  shuffle          boolean NOT NULL DEFAULT false,
  footer_text      text NOT NULL DEFAULT '',
  archived         boolean NOT NULL DEFAULT false,
  created_by_email text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id          bigserial PRIMARY KEY,
  playlist_id bigint NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id    bigint NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  idx         integer NOT NULL DEFAULT 0,
  seconds     integer NOT NULL DEFAULT 0,  -- 0 = playlist/app default (video: natural length)
  fit         text NOT NULL DEFAULT '',    -- '' = inherit
  enabled     boolean NOT NULL DEFAULT true,
  note        text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS playlist_items_playlist_idx ON playlist_items (playlist_id, idx);

-- An item can retire itself. Without this a notice stays up until somebody
-- remembers to take it down, which is how a narthex screen slowly fills with
-- last month's news. Dates are inclusive and read in the app's timezone.
ALTER TABLE playlist_items ADD COLUMN IF NOT EXISTS show_from  date;
ALTER TABLE playlist_items ADD COLUMN IF NOT EXISTS show_until date;

-- The two modes the narthex staff asked for, plus a recurring one for the
-- weekly Sunday slot:
--   window     - starts_at .. ends_at, then it is over
--   until_next - starts_at, then plays until another until_next entry starts
--   recurring  - days-of-week + a local time range, optionally date-bounded
CREATE TABLE IF NOT EXISTS schedule_entries (
  id               bigserial PRIMARY KEY,
  playlist_id      bigint NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  mode             text NOT NULL,
  label            text NOT NULL DEFAULT '',
  starts_at        timestamptz,
  ends_at          timestamptz,
  days             integer[] NOT NULL DEFAULT '{}',   -- 0=Sunday .. 6=Saturday
  start_time       text NOT NULL DEFAULT '',          -- 'HH:MM' in the app timezone
  end_time         text NOT NULL DEFAULT '',
  effective_from   date,
  effective_to     date,
  priority         integer NOT NULL DEFAULT 0,
  enabled          boolean NOT NULL DEFAULT true,
  created_by_email text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedule_entries_mode_idx ON schedule_entries (mode, starts_at);

-- A physical display. The token is how the TV authenticates: it cannot sign in
-- with Google, so /player and /api/player/* sit outside the hub's forward-auth
-- and are gated on this instead.
CREATE TABLE IF NOT EXISTS screens (
  id                 bigserial PRIMARY KEY,
  name               text NOT NULL,
  token              text NOT NULL UNIQUE,
  rotation           integer NOT NULL DEFAULT 0,   -- 0 | 90 | 180 | 270
  enabled            boolean NOT NULL DEFAULT true,
  last_seen_at       timestamptz,
  last_seen_ip       text NOT NULL DEFAULT '',
  last_revision      text NOT NULL DEFAULT '',
  last_playing       text NOT NULL DEFAULT '',
  created_by_email   text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- When the narthex screen is awake. Outside these the player renders true
-- black, and (optionally) a power action is fired at each boundary.
CREATE TABLE IF NOT EXISTS operating_hours (
  id         bigserial PRIMARY KEY,
  day        integer NOT NULL,            -- 0=Sunday .. 6=Saturday
  start_time text NOT NULL,               -- 'HH:MM' in the app timezone
  end_time   text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operating_hours_day_idx ON operating_hours (day, start_time);

-- An audit trail for the power hook. A TV that did not come on is the sort of
-- thing somebody notices on a Sunday morning, and this is where they look.
CREATE TABLE IF NOT EXISTS power_events (
  id       bigserial PRIMARY KEY,
  action   text NOT NULL,                 -- on | off | test-on | test-off
  ok       boolean NOT NULL,
  detail   text NOT NULL DEFAULT '',
  fired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS power_events_fired_idx ON power_events (fired_at DESC);
`;