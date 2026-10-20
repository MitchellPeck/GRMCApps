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
