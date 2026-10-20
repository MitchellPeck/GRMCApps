# Content Pipeline — audit findings and design decisions

Source plan: "Content Pipeline Dashboard: Build Plan" (Oct 20, 2026). This note
is Phase 1's findings note: what the social-posts app actually is, and where the
build departs from the plan's assumptions because of it.

## What exists (audit)

| Area | Finding |
| --- | --- |
| Runtime | Fastify 5 + `pg`, TypeScript compiled to CommonJS, one container (`apps/social-posts`). No ORM. |
| Migrations | None as such: `src/schema.ts` is idempotent DDL (`CREATE TABLE IF NOT EXISTS`) run by `ensureSchema()` on boot. |
| Auth | Traefik forwardAuth from the hub injects `X-Auth-Email` / `X-Auth-Name`. No users table in this DB; the hub exposes a directory at `hub/api/users?app=<slug>` (used by expenses and narthex-tv pickers). |
| UI | No framework, no build: `src/public/index.html` + `app.js` (string-built HTML, `esc()`/`jsq()`), shared `/assets/grmc.css` tokens (navy `#092D3E`, gold `#D3B02B`, paper/card) and `grmc-nav.js` app switcher. |
| Validation | None shared. The closest idiom is "server owns the list" (`/api/podcast/angles` feeds the checkboxes). |
| API style | Every route returns `{ ok: true, ... }` or `{ ok: false, error }` with HTTP 200. |
| Tests | `node --test` on compiled `dist/*.test.js`; DB tests use `TEST_DATABASE_URL`. |
| Deploy | Pushing `main` auto-deploys on the host (launchd `auto-deploy.sh` + Watchtower). Schema changes therefore apply on the next container start. |

### The "existing post record" is really three things

- `series` / `series_posts` — planned multi-week series. `series_posts.date` is a
  year-less label ("Aug 5"); status is `pending | drafted | posted`; the
  Claude draft is stored in `series_posts.draft`. Key is `(series_id, post_idx)`.
- `post_drafts` — an append-only log of the Wednesday / Friday / Podcast runs'
  output (`run`, `key` = weekday or podcast angle, `post_date`, `text`).
- `metricool_sends` — a log of what was pushed to Metricool.

None of these can hold a hand-planned post (e.g. a Kids Camp teaser), so the
plan's "extend the post table" is not workable literally.

## Decisions

1. **New `content_items` table, linked to the old records.** It carries the
   plan's fields plus `title` and `caption`, and nullable links
   `series_id`/`post_idx` (unique together) and `draft_id` (→ `post_drafts`).
   Existing tables are untouched; the migration is purely additive.
2. **One source of truth for series posts.** Once a series post has a content
   item, the Series tab reads status and draft *from the content item*
   (`getSeriesPosts` joins it). Series-tab writes go to the content item too;
   the legacy `series_posts.status/draft` columns are still written so a
   rollback to the previous image loses nothing.
3. **Events.** `events.id` is text (default `gen_random_uuid()`), matching the
   app's text ids. One event per series (`kind = series`, `series_id` set).
   The three automated runs get fixed standing events — `run-wednesday`
   ("Grace Notes & Sunday invite"), `run-friday` ("Weekly blog"),
   `run-podcast` ("Podcast") — with `kind = series` and no `series_id`.
4. **People are emails.** `owner_email` / `assignee_email` instead of user
   foreign keys; pickers come from the hub directory.
5. **Validation lives on the server** (`src/pipeline/rules.ts`). The client
   gets the enums, platform list and thresholds from `GET /api/pipeline/meta`,
   so the dropdowns cannot drift from what the server accepts — the same
   pattern as the podcast angles.
6. **Automated drafting lands in the pipeline.** Each run's drafts become (or
   refresh) a content item with status Drafted and its schedule date; a re-run
   for the same day and key updates the existing item instead of duplicating
   it, unless that item has already moved past Drafted. Series drafting moves
   the linked item to Drafted. A successful Metricool send with a known content
   item marks it Scheduled.
7. **Backfill** runs idempotently on boot: events for each series, a content
   item per series post (pending→Idea, drafted→Drafted, posted→Published;
   `sub` becomes the brief; the date label resolves through the existing
   `suggestDate`). Historical `post_drafts` rows are *not* backfilled — they
   would flood the calendar with stale "Drafted" items. A dry run
   (`node dist/pipeline/backfill-dry-run.js`) previews the result inside a
   rolled-back transaction.
8. **UI** is a second page in the same app, `/pipeline`, linked from the Social
   Posts tab bar. Adding it to the hub's app switcher would need its own
   subdomain (the registry links to subdomain roots), which the plan rules out.

## Open questions — v1 answers used

| Question | v1 answer |
| --- | --- |
| Edit vs view roles | Any signed-in user with access to Social Posts can edit. |
| One capture for several posts | No; a media asset belongs to exactly one post. |
| Platforms | Instagram, Facebook, X (X because the app already sends there). Edit `src/pipeline/config.ts`. |
| Gap thresholds | 7 days (readiness), 21 days (unscheduled media), in `src/pipeline/config.ts`. |
| Media files | Linked via `file_link`; nothing uploaded. |

## Rolling it out (Phase 1 backup → Phase 2 live)

Shipping is `docker compose build && docker compose push` on the build Mac;
Watchtower restarts social-posts on the host within ~2 minutes, and the new
container creates the tables and runs the backfill on boot. So **back up on
the host before pushing**:

```bash
# On the always-on host, from the repo folder
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc socialposts' \
  > ~/socialposts-before-pipeline-$(date +%F).dump
```

(The database name is whatever `SOCIALPOSTS_DB_NAME` is in the host's `.env`.)
That is the database itself; the whole `pgdata` volume is already covered by
`scripts/migrate-export.sh` if you want a belt-and-braces copy.

To preview the backfill against live data first, pull the new image on the
host and run the dry run. It rolls back everything, including the new tables:

```bash
docker compose pull social-posts
docker compose run --rm --no-deps social-posts node dist/pipeline/backfill-dry-run.js
```

Rolling back means redeploying the previous image. The old app ignores the
new tables, and the Series tab's legacy columns have been kept current
throughout, so nothing it shows is lost. To undo the schema as well, restore
the dump above.

## Iteration 2: recurring posts and workflow extras

- **Recurring posts** (`recurrences` table, `src/pipeline/recurrence.ts` for
  the rules and `recurring.ts` for storage). A recurrence is a template plus a
  rule: weekly on chosen days, every N weeks, monthly on a date (clamped to
  short months), or monthly on the nth or last weekday. Each one ends never, on
  a date, or after N posts. The generator materialises occurrences as ordinary
  `content_items` (`recurrence_id`, `occurrence_date`, unique together),
  56 days ahead. It runs on boot, daily, and on demand when the calendar asks
  for a later range. Past dates are never filled in.
  - A single-post edit to a template field sets `detached`. Series edits
    ("this and future", or the series editor) reach only untouched (Idea or
    Planned), non-detached occurrences from that date on.
  - Deleting an occurrence cancels it instead, so the generator never brings
    it back. A rule change or a pause removes untouched future slots that no
    longer fit.
  - Template media is marked `from_template`. A new media list replaces only
    template media that hasn't been captured; hand-added media stays.
- **Weekly runs as recurrences**, seeded once (`pipeline_run_recurrences_v1`):
  Grace Notes on Wednesdays, the Sunday invite on Saturdays, the Weekly blog
  on Fridays. All are "no media needed" until someone adds a media list. A run
  fills its slot by matching event, draft key and occurrence date.
- **Send to Metricool** from the drawer. The dialog moved to the shared
  `public/metricool-modal.js`, so Social Posts and the pipeline use the same
  one.
- **Draft with Claude** (`POST /content/:id/draft-caption`) from the title,
  brief and event notes, using the house `VOICE`. It returns text and saves
  nothing.
- **My work** tab, **duplicate event** (`POST /events/:id/duplicate`, every
  date shifted by the same offset), and a **capture calendar iCal feed**.
- **Dashboard pipeline counts** now come from the board's own query (from
  30 days ago on, plus undated, with the filters), so the two always agree.
  They used to count every post ever made.

### iCal feed deploy note

`/ical/<token>/capture.ics` must be reachable without the hub login, so
`docker-compose.yml` gains a second Traefik router (`social-ical`) on that
path prefix with no forward-auth middleware. The token in the path is the
credential: random, compared in constant time, and resettable from My work.
**Watchtower does not apply label changes.** After this ships, run
`docker compose up -d social-posts` on the host (or let `auto-deploy.sh` do it
once the change is on `main`). Until then the feed URL redirects to the hub
login.

## Iteration 3: per-platform captions, the image rule, one editor

- **Captions per platform.** `content_items.caption_mode` is `same` (one
  `caption` everywhere) or `separate` (`captions` jsonb, keyed by platform).
  Platform limits live in `config.ts` (`PLATFORMS`: `limit`, `urlLength`,
  `needsImage`, plus Claude `guidance`) and are counted the platform's way in
  `platforms.ts`; X charges 23 per link. Over-limit captions save with a
  warning and show a red counter, but aren't blocked.
- **Draft with Claude** (`POST /api/pipeline/draft-caption`) drafts from the
  editor's current state, saved or not. In separate mode it asks for one post
  per selected platform with that platform's guidance; an over-long X draft
  gets one "shorten to 250" retry before it's returned with a warning.
- **Instagram needs an image.** `imageRuleError` refuses Instagram together
  with "No media needed", on posts and recurrences, on the server as well as
  in the editor. A one-time fix (`pipeline_image_rule_v1`) gives the weekly-run
  recurrences an "Image for the post" to collect and clears their text-only
  flag (the user chose to keep Instagram); any other text-only post loses
  Instagram.
- **Send to Metricool** with separate captions sends one Metricool post per
  distinct text. The shared dialog takes `texts` per network, and
  `approvedImageId` to preselect the post's Approvals file.
- **Media.** A "Collected" box (`captured`, no link needed). `approval_id` /
  `approval_title` hold a file chosen from Approvals; thumbnails are proxied
  through `/api/pipeline/approved/:id/image` as the signed-in user. Attaching
  a file or link makes media `edited` (shown as "Final file"); removing it
  leaves it collected.
- **One editor.** The drawer is built by one function whatever opens it. A new
  post shows the full media section; its media is kept client-side and created
  right after the post. Before, a new post showed "create the post first" in
  place of the media list. **Make it repeat** on an existing one-off post
  makes it the series' first occurrence (`fromContentId`).

## Iteration 4: uploading a media item's file

A media item's file can now be uploaded as well as picked from Approvals or
linked. `POST /api/pipeline/uploads` takes the raw bytes (photos JPG/PNG/GIF/
WebP, videos MP4/MOV, at most 100 MB, which is Cloudflare's tunnel limit),
stores them in the existing R2 bucket under `media/`, and returns the public
URL. The editor saves it as the item's `file_link` with `file_name` and
`file_type`, which works before the post is first saved. Attaching makes the
item "Final file"; Remove detaches it but leaves the object in R2. Send to
Metricool preselects an Approvals file, else an uploaded photo.
