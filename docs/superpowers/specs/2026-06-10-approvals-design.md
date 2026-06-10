# GRMC Approvals — Design Spec

**Date:** 2026-06-10
**Status:** Approved (pending final spec review)
**Depends on:** the apps-hub skeleton (`docs/superpowers/specs/2026-06-10-apps-hub-design.md`) — Traefik forwardAuth gateway, Postgres database-per-app, Google-OIDC hub.

## 1. Purpose

A new hub app for requesting and granting sign-off on **graphics**. A submitter uploads an image, picks an approver from a roster, and the approver approves, rejects, or requests changes. When changes are requested, the submitter uploads a new version and the request returns to pending. The app keeps every version and a full decision log.

Graphics is the first asset type. The data model and UI are kept generic enough that other asset types could follow later, but **this spec covers graphics only** — no other types are built now.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Where it runs | New app container `apps/approvals/`, gated by hub forwardAuth |
| Host | `app-approvals.lvh.me` |
| Registry slug | `approvals` |
| Database | Own `approvals` Postgres DB + isolated role (per-app pattern) |
| Stack | Node + TypeScript + Fastify + `pg` (matches social-posts) |
| Frontend | Single fetch-based static page in `src/public` (no framework), tabbed UI |
| Asset source | Uploaded image files (PNG/JPG/WebP/GIF/PDF), stored in the app DB |
| Image storage | **Postgres `bytea`** — self-contained, backed up with the existing `pgdata` volume, no extra compose wiring. ~10 MB per-file cap. |
| Who can submit | Any logged-in hub user |
| Who can approve | **One approver per request**, chosen from a roster managed in the Settings tab; matched by email |
| Lifecycle | `pending` → `approved` / `rejected` / `changes_requested`; a new version after changes returns to `pending` |
| Versioning | Every uploaded version retained; decision/audit log per request |
| Data scope | Shared workspace — all logged-in hub users share the roster; visibility is by role (see §6) |
| Schema management | App creates its own tables on boot (`CREATE TABLE IF NOT EXISTS`); DB + role provisioned via `db/init` |
| Uploads | `@fastify/multipart`; validate MIME type + size, reject with `{ ok:false, error }` |

## 3. Architecture

```
browser → https://app-approvals.lvh.me → Traefik (forwardAuth → hub /auth/verify)
                                            │ injects X-Auth-* identity headers
                                            ▼
                           approvals (Fastify, port 3000)
                            ├─ serves index.html + app.js (the UI)
                            ├─ /api/* REST endpoints
                            └─ Postgres `approvals` DB (metadata + image bytea)
```

Identity arrives only as `x-auth-email` / `x-auth-name` headers (per `identity.ts`). There is no separate login; the host is fully gated by the hub. All permission checks compare the caller's email to stored emails.

## 4. Data model (`approvals` DB)

All DDL is idempotent and runs on boot via `ensureSchema()`.

```sql
-- Approver candidates, managed in Settings.
CREATE TABLE IF NOT EXISTS roster (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  email       text UNIQUE NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One approval request.
CREATE TABLE IF NOT EXISTS requests (
  id               bigserial PRIMARY KEY,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  submitter_email  text NOT NULL,
  submitter_name   text NOT NULL DEFAULT '',
  approver_email   text NOT NULL,
  approver_name    text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'pending',   -- pending|approved|rejected|changes_requested
  current_version  integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz
);

-- Each uploaded version of a request's graphic.
CREATE TABLE IF NOT EXISTS request_versions (
  request_id        bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  version_no        integer NOT NULL,
  file_name         text NOT NULL,
  mime_type         text NOT NULL,
  byte_size         integer NOT NULL,
  image             bytea NOT NULL,
  note              text NOT NULL DEFAULT '',
  uploaded_by_email text NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, version_no)
);

-- Decision / audit log.
CREATE TABLE IF NOT EXISTS request_events (
  id           bigserial PRIMARY KEY,
  request_id   bigint NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  version_no   integer NOT NULL,
  type         text NOT NULL,        -- submitted|resubmitted|approved|rejected|changes_requested
  actor_email  text NOT NULL,
  actor_name   text NOT NULL DEFAULT '',
  comment      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

## 5. State machine

Allowed transitions (enforced by a pure function, unit-tested):

| From | Action | Actor | To | Side effects |
|---|---|---|---|---|
| — | submit | any user | `pending` | create request v1, `submitted` event |
| `pending` | approve | approver | `approved` | `approved` event, set `decided_at` |
| `pending` | reject | approver | `rejected` | `rejected` event, set `decided_at` |
| `pending` | request_changes | approver | `changes_requested` | `changes_requested` event (comment required) |
| `changes_requested` | new version | submitter | `pending` | add version `current_version+1`, `resubmitted` event |

Any other transition is rejected with a 4xx and `{ ok:false, error }`. `approved` and `rejected` are terminal — no further actions.

## 6. API

All responses follow the existing `{ ok: true, ... }` / `{ ok: false, error }` convention.

- `GET  /api/me` — `{ email, name }` from headers.
- `GET  /api/roster` — active roster entries (for the submit dropdown); include inactive for Settings.
- `POST /api/roster` — `{ name, email }` add/reactivate (email unique).
- `POST /api/roster/:id` — `{ active }` toggle.
- `POST /api/requests` — multipart: `title`, `description`, `approverId`, `file`. Creates request v1, `pending`. Validates type/size and that `approverId` is an active roster entry.
- `GET  /api/requests?box=inbox|sent` — `inbox` = requests where caller is approver **and** status is `pending` (actionable by them); `sent` = requests caller submitted (any status). Returns list with status + latest-version metadata (no bytes).
- `GET  /api/requests/:id` — detail: request + all versions (metadata) + events. Visible only to that request's submitter or approver.
- `GET  /api/requests/:id/versions/:n/image` — streams the bytes with the stored MIME type. Same visibility rule.
- `POST /api/requests/:id/decision` — `{ action: approve|reject|request_changes, comment }`. Approver only; status must be `pending`. `request_changes` requires a non-empty comment.
- `POST /api/requests/:id/versions` — multipart: `file`, `note`. Submitter only; status must be `changes_requested`. Bumps version, returns to `pending`.

**Permissions:** non-approver decision → 403; non-submitter version upload → 403; viewing a request you're neither party to → 403/404.

## 7. Frontend

Single static page (`src/public/index.html` + `app.js`), tabbed, fetch-based — matching the social-posts style.

- **Inbox** — requests awaiting my decision (I'm the approver, status `pending`). Image preview, description, version history, and Approve / Reject / Request Changes controls with a comment box.
- **My Requests** — requests I submitted, with current status; when `changes_requested`, an "upload new version" control; shows the approver's comments and full history. (After I upload a new version it returns to `pending` and reappears in the approver's Inbox.)
- **New Request** — title, description, approver dropdown (active roster), file picker with client-side type/size hint; submit.
- **Settings** — manage the roster (add name+email, toggle active).

Image preview uses the `/versions/:n/image` endpoint as an `<img src>` (or a download link for PDFs).

## 8. Uploads & validation

- `@fastify/multipart` with a ~10 MB file-size limit.
- Accept MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `application/pdf`.
- Reject oversize / wrong-type with `{ ok:false, error }` (no exception leakage).
- Store raw bytes in `request_versions.image`; serve back with the recorded `mime_type` and a sensible `Content-Disposition`/cache header.

## 9. Error handling

- Route handlers wrap logic in try/catch and return `{ ok:false, error }` on failure (existing pattern), never leaking stack traces to the client.
- Permission failures return explicit 403 with a clear message.
- State-machine violations (e.g., approving an already-approved request) return 4xx with `{ ok:false, error }`.

## 10. Testing

`node --test` (matches social-posts). Unit-test the pure logic, decoupled from `pg`:

- **State machine:** every allowed transition succeeds; representative disallowed transitions are rejected.
- **Permissions:** approver/submitter checks (by email) admit the right actor and reject others.
- **Validation:** MIME/size acceptance and rejection.
- **Roster:** add (unique email / reactivate), toggle active.

Pure functions take plain inputs (status, actor email, request parties) so they need no database.

## 11. Wiring (hub integration)

1. `apps/approvals/` — `Dockerfile`, `package.json` (add `@fastify/multipart`), `tsconfig.json`, `src/` (clone the social-posts layout).
2. `db/init/01-databases.sh` — add `create_app_db "$APPROVALS_DB_NAME" "$APPROVALS_DB_USER" "$APPROVALS_DB_PASSWORD"`.
3. `db/init/02-hub-schema.sql` — seed `apps` row (`approvals`, `Approvals`, `app-approvals.lvh.me`, icon e.g. ✅). *Note: `02-hub-schema.sql` only runs on first DB init; for an existing volume the row is inserted with a one-off statement, same as social-posts.*
4. `docker-compose.yml` — `approvals` service mirroring `social-posts` (forward-auth middleware, port 3000, `APPROVALS_DB_*` env).
5. `.env` / `.env.example` — `APPROVALS_DB_NAME=approvals`, `APPROVALS_DB_USER=approvals_user`, `APPROVALS_DB_PASSWORD=...`.
6. `config.ts` — build `databaseUrl` from `APPROVALS_DB_*` (mirrors social-posts `config.ts`).
7. README — add an Approvals entry under "Apps".

## 12. Out of scope (v1)

- Email / push notifications (in-app lists only).
- Multiple approvers per request.
- Asset types other than graphics.
- Editing/deleting submitted requests (beyond uploading new versions).
- External object storage.
