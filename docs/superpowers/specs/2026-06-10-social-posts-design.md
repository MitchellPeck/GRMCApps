# GRMC Social Posts — Design Spec

**Date:** 2026-06-10
**Status:** Approved (pending final spec review)
**Depends on:** the apps-hub skeleton (`docs/superpowers/specs/2026-06-10-apps-hub-design.md`) — Traefik forwardAuth gateway, Postgres database-per-app, Google-OIDC hub.

## 1. Purpose

Port the existing Google Apps Script "GRMC Social Posts" tool into a hub-native application. It drafts social media posts for Grace Resurrection Methodist Church using Claude, pulls Grace Notes / Weekly Blog content from Mailchimp, and manages multi-week post "series." The rewrite reproduces the reference app **1:1 in features and UI**, re-platformed onto the hub stack (Node/TypeScript/Fastify + Postgres, behind Traefik forwardAuth).

This is a faithful port: same Claude voice rules, same Monday/Wednesday/Friday draft runs, same Series system, the same seeded "History of GRMC" series, the same Mailchimp fetching/cleaning, and the same polished UI. No behavioral changes beyond what the platform requires.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Where it runs | New app container `apps/social-posts/`, gated by hub forwardAuth |
| Host | `app-social.lvh.me` |
| Registry slug | `social-posts` |
| Database | Own `socialposts` Postgres DB + isolated role (per-app pattern) |
| Stack | Node + TypeScript + Fastify (matches hub) |
| Frontend | Reuse the reference HTML/CSS; `google.script.run` → `fetch` to REST API |
| API keys / secrets | Stored in the `socialposts` DB `settings` table, set via the in-app Settings tab (plaintext — acceptable for a local, authenticated, single-church tool) |
| Data scope | Shared workspace — all logged-in hub users share series/drafts/settings; drafts stamped with `created_by` from `X-Auth-Email` |
| Claude model | `claude-sonnet-4-6`, anthropic-version `2023-06-01`, max_tokens 1024 (same as reference) |
| Schema management | App creates its own tables on boot (`CREATE TABLE IF NOT EXISTS`); DB+role provisioned via `db/init` + one-off create against the existing volume |
| Feature scope | Faithful 1:1 port (no features added or cut) |

## 3. Architecture

```
browser → https://app-social.lvh.me → Traefik (forwardAuth → hub /auth/verify)
                                          │ injects X-Auth-* identity headers
                                          ▼
                         social-posts (Fastify, port 3000)
                          ├─ serves index.html + app.js (the UI)
                          ├─ /api/* REST endpoints
                          ├─ Claude Messages API (server-side)
                          ├─ Mailchimp API (server-side)
                          └─ Postgres `socialposts` DB
```

The app has **no auth code**: the whole host is gated by forwardAuth, so every request is authenticated. The app reads `X-Auth-Email` / `X-Auth-Name` only to stamp `created_by` and show who's logged in.

## 4. How Apps Script concepts map

| Apps Script | New app |
|---|---|
| `doGet` / `HtmlService` | Fastify serves `public/index.html` + `public/app.js` |
| `google.script.run.fn(args)` (success/failure handlers) | `fetch('/api/...')`; endpoints return the same `{ok, ...}` shapes so UI logic ports 1:1 |
| `PropertiesService` script properties | `settings` table (key/value) |
| `SpreadsheetApp` sheets (Series, SeriesPosts, PostDrafts) | Postgres tables |
| `UrlFetchApp` → Claude / Mailchimp | server-side `fetch` |
| `Logger.log` | Fastify logger |
| (none) | identity from `X-Auth-*` headers |

## 5. Data model (`socialposts` DB)

```sql
settings
  key         text PRIMARY KEY      -- 'anthropic_api_key' | 'mailchimp_api_key' | 'mailchimp_server'
  value       text NOT NULL
  updated_at  timestamptz NOT NULL DEFAULT now()

series
  id          text PRIMARY KEY      -- 'series-<ts>' or 'series-history'
  name        text NOT NULL
  description text NOT NULL DEFAULT ''
  context     text NOT NULL DEFAULT ''
  cadence     text NOT NULL DEFAULT 'weekly'
  status      text NOT NULL DEFAULT 'active'   -- active | paused | complete
  created_at  timestamptz NOT NULL DEFAULT now()

series_posts
  series_id   text NOT NULL REFERENCES series(id) ON DELETE CASCADE
  post_idx    integer NOT NULL
  date        text NOT NULL DEFAULT ''         -- e.g. 'Jun 9' (free text, as in reference)
  phase       text NOT NULL DEFAULT ''
  title       text NOT NULL
  sub         text NOT NULL DEFAULT ''         -- "angle"
  status      text NOT NULL DEFAULT 'pending'  -- pending | drafted | posted
  draft       text NOT NULL DEFAULT ''
  notes       text NOT NULL DEFAULT ''
  PRIMARY KEY (series_id, post_idx)

post_drafts
  id          bigserial PRIMARY KEY
  run         text NOT NULL                    -- monday | wednesday | friday
  post_date   text NOT NULL DEFAULT ''
  key         text NOT NULL                    -- monday|tuesday|thursday|wednesday|saturday|friday
  text        text NOT NULL
  status      text NOT NULL DEFAULT 'draft'
  created_by  text NOT NULL DEFAULT ''         -- X-Auth-Email
  created_at  timestamptz NOT NULL DEFAULT now()
```

On first `GET /api/series`, if `series` is empty, seed the **"History of GRMC"** series (`series-history`) and its 13 posts (the `HISTORY_SERIES_POSTS` data carried over verbatim), exactly like the reference's `seedHistorySeries`.

## 6. Backend modules & endpoints

**Modules** (each one focused responsibility):
- `config.ts` — env (port 3000, `SOCIALPOSTS_DATABASE_URL`)
- `db.ts` — `pg` pool + `ensureSchema()` (runs the `CREATE TABLE IF NOT EXISTS` DDL on boot)
- `settings.ts` — `getSetting(key)`, `setSetting(key,value)`, and `getSettingsView()` (hint + has-flags, never returns full keys)
- `voice.ts` — `VOICE` string + `HISTORY_SERIES_POSTS` seed data
- `claude.ts` — `callClaude(system, user)` using the stored Anthropic key; throws if missing
- `mailchimp.ts` — `getMailchimpAuth()`, `getLatestGraceNotes(beforeDate)`, `getLatestBlog()`, shared content-cleaning (header/footer stripping)
- `series.ts` — series + series_posts data access; `createSeries`, `getAllSeries` (seeds history if empty), `getSeriesPosts`, `updateSeriesPostField`, `updateSeriesMeta`, `draftSeriesPost`, `generateSeriesPostsWithClaude`, `getActiveSeriesThursdayItem`
- `drafts.ts` — `savePostDrafts(run, postDate, posts, createdBy)`, `getRecentDrafts()`
- `runs.ts` — `draftMondayPosts`, `draftWedPosts`, `draftFridayPost` (compose prompts, call Claude, save)
- `identity.ts` — read `X-Auth-*` headers
- `routes/*.ts` — thin HTTP handlers wiring requests to the modules
- `index.ts` — Fastify bootstrap: static file serving, route registration, `ensureSchema()` on start

**Endpoints** (request → reference function):

| Method & path | Reference fn | Notes |
|---|---|---|
| `GET /api/me` | — | returns `{email, name}` from headers |
| `GET /api/settings` | `getSettings` | hint + has-flags only |
| `POST /api/settings` | `saveSettings` | save keys/server |
| `POST /api/draft/monday` | `draftMondayPosts` | body: date, sermon, pulpit, events, highlights |
| `POST /api/draft/wednesday` | `draftWedPosts` | body: sundayDate, manualUrl, content, service |
| `POST /api/draft/friday` | `draftFridayPost` | body: date, manualUrl, content, subject |
| `GET /api/grace-notes?sundayDate=` | `fetchGraceNotes` | preview only |
| `GET /api/blog` | `fetchBlog` | preview only |
| `GET /api/series` | `getAllSeries` | seeds history if empty |
| `GET /api/series/:id/posts` | `getSeriesPosts` | |
| `POST /api/series` | `createSeries` | body: name, description, context, cadence, posts[] |
| `POST /api/series/plan` | `generateSeriesPostsWithClaude` | returns generated plan |
| `POST /api/series/:id/posts/:idx/draft` | `draftSeriesPost` | |
| `PATCH /api/series/:id/posts/:idx` | `updateSeriesPostField` | body: `{field, value}` (status/notes/draft) |
| `PATCH /api/series/:id` | `updateSeriesMeta` | body: `{status}` etc. |
| `GET /api/drafts` | `getRecentDrafts` | last 20, newest first |

All endpoints return `{ok:true, ...}` or `{ok:false, error}`.

## 7. Frontend

Reuse the reference `index.html` + CSS verbatim (the GRMC navy/gold design). Extract the inline `<script>` into `public/app.js`, replacing the `google.script.run.withSuccessHandler(cb).withFailureHandler(fb).fn(args)` pattern with a small helper:

```js
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json(); // endpoints already return {ok, ...}
}
```

Each existing call site is rewritten to `api(...)` with the same success/failure branches (since the `{ok,...}` payloads are unchanged). Reads → GET, draft/create → POST, field updates → PATCH. The header shows the logged-in user (from `/api/me`). All tab logic, series rendering, plan editing, copy-to-clipboard, drafts list, and settings behavior are preserved.

## 8. Provisioning the database

- Add `socialposts` DB + `socialposts_user` role to `db/init/01-databases.sh` (for fresh `docker compose up` setups) and to `.env` / `.env.example` (`SOCIALPOSTS_DB_*`).
- Because init scripts only run on a fresh volume, **also create the DB + role once against the running Postgres** via a one-off `psql` (non-destructive) so we don't have to wipe existing data.
- Register the app in the hub: add a row to the hub `apps` table (`slug=social-posts`, `name=Social Posts`, `host=app-social.lvh.me`, icon) — via an `INSERT ... ON CONFLICT DO NOTHING` against the running hub DB, and add the same seed line to the hub's `db/init/02-hub-schema.sql` for fresh setups.

## 9. Error handling

- Missing Anthropic key → `callClaude` throws `"No Anthropic API key. Go to Settings to add it."`; endpoint returns `{ok:false, error}`; UI shows the existing alert.
- Mailchimp not configured / no matching campaign → the draft endpoints fall back to manual input exactly as the reference does (`mailchimpFetched:false`, `mailchimpError`).
- Claude returning non-JSON → strip ```json fences then `JSON.parse`; parse failure → `{ok:false, error}`.
- All handlers wrap work in try/catch and never leak stack traces to the client.

## 10. Testing

- **Pure-logic unit tests** (no network): Mailchimp content cleaning (header rule + footer-marker stripping), the ```json fence stripper, and `getActiveSeriesThursdayItem` date matching.
- **DB round-trips** against the running `socialposts` DB: settings set/get (and that `getSettingsView` never returns the raw key), series create → list → posts → update field → update meta.
- **Gated-access check**: unauthenticated request to `app-social.lvh.me` 302s to hub login (proves it's wired into forwardAuth).
- **Manual**: full Monday/Wednesday/Friday/Series drafting with a real Anthropic key, and Mailchimp fetch with real Mailchimp creds (entered via Settings).

## 11. Repository structure

```
apps/social-posts/
  Dockerfile
  package.json
  tsconfig.json
  src/
    index.ts          config.ts        db.ts
    settings.ts       voice.ts         claude.ts        mailchimp.ts
    series.ts         drafts.ts        runs.ts          identity.ts
    schema.sql        (DDL run by ensureSchema)
    routes/
      settings.ts  drafts.ts  mailchimp.ts  series.ts  me.ts
    public/
      index.html  app.js
```

## 12. Out of scope

- Scheduling/auto-posting to social platforms (the tool drafts; posting is manual, as in the reference).
- Multi-tenant / per-user data partitioning.
- Encrypting API keys at rest (plaintext in DB, by decision).
- Editing/deleting historical drafts (not in the reference).

## 13. Success criteria

1. `app-social.lvh.me` appears on the hub dashboard and opens (authenticated) to the ported UI.
2. Settings tab saves Anthropic + Mailchimp keys to the `socialposts` DB; header shows "API key set".
3. Monday/Wednesday/Friday runs produce drafts via Claude and save them to `post_drafts` (stamped with the logged-in email); Drafts tab lists them.
4. Series tab shows the seeded "History of GRMC" series; per-post drafting, mark-posted, notes, pause/resume, and "new series via Claude plan" all work.
5. Mailchimp "Preview Grace Notes" / "Fetch blog" pull and clean the latest campaign content (with real creds).
6. `socialposts` is a separate database owned by `socialposts_user`.
