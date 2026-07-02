-- Idempotent seed of the hub "Your Apps" registry.
--
-- Runs in TWO situations, safely in both (ON CONFLICT DO NOTHING):
--   1. On a fresh Postgres volume, via /docker-entrypoint-initdb.d (after
--      02-hub-schema.sql has created the apps table).
--   2. On every `docker compose up`, via the one-shot db-init service, so a new
--      app registers against a LIVE hub DB without any manual INSERT.
--
-- To add an app: append a row below. Existing rows are never overwritten, so
-- edits to a name/icon here won't propagate to an already-seeded row (change
-- those with an explicit UPDATE if needed).
\connect hub

INSERT INTO apps (slug, name, subdomain, icon) VALUES
  ('whoami',          'Who Am I',        'whoami',    '👤'),
  ('social-posts',    'Social Posts',    'social',    '📣'),
  ('approvals',       'Approvals',       'approvals', '✅'),
  ('meeting-minutes', 'Meeting Minutes', 'minutes',   '📝')
ON CONFLICT (slug) DO NOTHING;
