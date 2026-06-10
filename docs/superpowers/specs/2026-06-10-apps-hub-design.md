# GRMC Apps Hub — Design Spec

**Date:** 2026-06-10
**Status:** Approved (pending final spec review)
**Scope of this spec:** The hub container, the reverse proxy, and the Postgres setup — the foundation that authenticates users and launches independent app containers. Individual business apps beyond a throwaway validation app are out of scope here; each real app gets its own spec later.

## 1. Purpose

GRMCApps is a locally-runnable "apps hub." Everything runs through Docker Compose. A central **hub** authenticates the user (via Google OIDC) and then gates access to a set of independent apps, each running in its own container. A single Postgres container backs the hub and every app, with strong per-app isolation.

This first pass delivers the runnable skeleton: reverse proxy + TLS, Postgres with database-per-app provisioning, the hub (login, sessions, identity verification endpoint, dashboard), and one throwaway `whoami` app that proves the end-to-end authentication pipeline.

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Hub type | Full-stack single container (server-rendered) | Self-contained; one thing owns identity |
| Hub stack | Node + TypeScript + **Fastify** | Modern, fast; `openid-client` is framework-agnostic |
| Auth source | External SSO — **Google OIDC** | No password storage |
| Auth flow to apps | **Gateway forward-auth** | Apps need zero auth code; trust injected headers |
| Routing | **Subdomains** `*.lvh.me` | Clean app roots; `lvh.me` resolves to 127.0.0.1 |
| TLS / domain | **HTTPS via mkcert** on `*.lvh.me` | Satisfies Google redirect rules; reliable cross-subdomain cookies |
| DB layout | **Database-per-app** | Each app gets its own DB + credentials; strong isolation |
| Reverse proxy | **Traefik** | Docker-native discovery + built-in `forwardAuth` |

### Why `lvh.me` + mkcert

Google only accepts redirect URIs that are `http://localhost`/`127.0.0.1` or a **public domain over HTTPS**, and rejects `http://hub.localhost`. `lvh.me` (and its subdomains) is a public domain that resolves to `127.0.0.1`, so:
- `https://hub.lvh.me/auth/callback` is a valid Google redirect URI.
- A session cookie scoped to `Domain=.lvh.me` is shared cleanly across `hub.lvh.me`, `app-whoami.lvh.me`, etc., in every browser (no `*.localhost` cookie fragility).

mkcert generates a locally-trusted wildcard cert for `*.lvh.me` that Traefik serves.

## 3. Architecture

```
   browser (*.lvh.me, HTTPS) ──► Traefik :443 ──forwardAuth──► Hub /auth/verify
                                     │                            │
                                     ├──► Hub (login, dashboard)  │
                                     ├──► app-whoami              ▼
                                     └──► (future apps)        Postgres
                                                                ├─ hub DB
                                                                └─ whoami DB, … (per app)
                                     Hub ──OIDC──► Google (external)
```

Four roles:
- **Traefik** — TLS termination, subdomain routing, and the forward-auth gate. Discovers services via Docker labels.
- **Hub** — the only OIDC client; owns identity, sessions, the app registry, the dashboard, and the `/auth/verify` endpoint.
- **Postgres** — one container; `hub` database plus one database per app, each with its own DB user/password. Not published to the host network by default.
- **Apps** — independent containers behind Traefik; trust `X-Auth-*` headers Traefik injects. `whoami` is the only one in this spec.

## 4. Components & technology

### Hub (`hub/`)
- Node + TypeScript + **Fastify**.
- `openid-client` — Google OIDC (authorization code flow, id_token validation).
- `@fastify/cookie` + `@fastify/session` with an **express-session-compatible Postgres store** (`connect-pg-simple`, which @fastify/session supports) — sessions persisted in the `hub` DB.
- `pg` — Postgres access.
- `@fastify/view` + EJS — two server-rendered pages: **login** and **dashboard**.
- Single container; the only service that talks to Google. Reachable only via Traefik.

### Traefik (`traefik/`)
- Static config (`traefik.yml`): entrypoints (`:80` → redirect to `:443`, `:443`), Docker provider, file provider for dynamic config.
- Dynamic config:
  - `tls.yml` — references the mkcert wildcard cert in `certs/`.
  - `middlewares.yml` — a `forwardAuth` middleware targeting `http://hub:PORT/auth/verify`, configured to copy `X-Auth-*` response headers upstream (`authResponseHeaders`).
- App containers attach via labels: a `Host` router rule + the `forwardAuth` middleware.

### Postgres (`db/`)
- Postgres 16, official image.
- `db/init/01-databases.sql` — creates the `hub` database and a `whoami` database, each with a dedicated role/password.
- `db/init/02-hub-schema.sql` — hub tables (see data model). Runs against the `hub` DB.
- Data persisted in a named Docker volume. Port not published by default (optional override for local DB tools).

### whoami app (`apps/whoami/`)
- Minimal container (tiny Node or even a static echo) that renders the `X-Auth-*` headers it receives. **Throwaway** — exists solely to validate the forward-auth pipeline end-to-end. Has its own `whoami` database to demonstrate per-app DB credentials, even if it does little with it.

## 5. Auth & data flow

### Login (unauthenticated request)
1. Browser → `https://app-whoami.lvh.me` → Traefik.
2. Traefik `forwardAuth` → `GET http://hub/auth/verify` with `X-Forwarded-*`.
3. Hub finds no valid session → responds **302** to `https://hub.lvh.me/auth/login?redirect=<original-url>`.
4. Hub `/auth/login` → `openid-client` builds Google authorization URL (state + PKCE) → redirect to Google.
5. Google → `https://hub.lvh.me/auth/callback` → hub exchanges code, validates id_token, **upserts the user** (`google_sub`, email, name, last_login), creates a session, sets the session cookie on `Domain=.lvh.me`.
6. Hub redirects the browser back to the original `redirect` URL.

### Authenticated request
1. Browser → `https://app-whoami.lvh.me` (now with session cookie) → Traefik.
2. `forwardAuth` → `GET /auth/verify`; hub validates the session, resolves the requested app by host, confirms access (v1: any logged-in user, app must be `enabled`).
3. Hub returns **200** with `X-Auth-User-Id`, `X-Auth-Email`, `X-Auth-Name`, `X-Auth-Roles`.
4. Traefik forwards those headers to the app; the app trusts them.

### Verify endpoint contract (`/auth/verify`)
- **200** + `X-Auth-*` headers → allowed.
- **302** → not authenticated; Location points to hub login with `redirect` back.
- **403** → authenticated but not authorized for this app (reserved for when roles are enforced).

### Logout
- `/auth/logout` destroys the session and clears the cookie, then redirects to the hub login/landing.

## 6. Data model (hub DB)

```sql
users
  id           uuid pk
  google_sub   text unique not null
  email        text not null
  name         text
  created_at   timestamptz default now()
  last_login   timestamptz

apps                         -- registry: drives dashboard + gated hosts
  id           uuid pk
  slug         text unique   -- e.g. 'whoami'
  name         text          -- display name
  host         text unique   -- e.g. 'app-whoami.lvh.me'
  icon         text
  enabled      boolean default true
  created_at   timestamptz default now()

session                      -- managed by connect-pg-simple
```

Roles/authorization are **designed for but not enforced** in v1: every logged-in user sees and can open every `enabled` app. The `/auth/verify` 403 path and `X-Auth-Roles` header exist so per-app authorization can be added later without reshaping the contract. `apps` is seeded with the `whoami` row.

## 7. Repository structure

```
docker-compose.yml
.env.example                 # GOOGLE_CLIENT_ID/SECRET, SESSION_SECRET, BASE_DOMAIN=lvh.me, DB creds
certs/                       # mkcert output — gitignored
traefik/
  traefik.yml                # static config
  dynamic/
    tls.yml
    middlewares.yml          # forwardAuth
hub/
  Dockerfile
  package.json  tsconfig.json
  src/
    index.ts                 # Fastify bootstrap
    config.ts                # env loading/validation
    db.ts                    # pg pool
    auth/
      oidc.ts                # openid-client (Google) setup
      session.ts             # @fastify/session + pg store
      routes.ts              # /auth/login, /auth/callback, /auth/logout, /auth/verify
    apps/
      registry.ts            # load apps from DB
      routes.ts              # dashboard
    views/                   # login.ejs, dashboard.ejs
db/
  init/
    01-databases.sql         # create hub + whoami databases & roles
    02-hub-schema.sql        # hub tables + seed apps
apps/
  whoami/
    Dockerfile
    ...                      # echoes X-Auth-* headers
```

## 8. Configuration & secrets

- `.env` (gitignored) holds: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `BASE_DOMAIN=lvh.me`, Postgres superuser creds, and per-DB credentials (`HUB_DB_*`, `WHOAMI_DB_*`).
- `.env.example` is committed with placeholder values and inline notes.
- `certs/` (mkcert output) is gitignored.
- Postgres init SQL reads credentials via env where the official image allows; otherwise credentials are templated at compose time.

## 9. Networking

- Single Docker bridge network. Only **Traefik** publishes host ports (`80`, `443`). Hub and Postgres are reachable only inside the network.
- Optional compose override can publish Postgres `5432` for local DB tooling.

## 10. Out of scope (this spec)

- Real business apps (each gets its own spec).
- Per-app role-based authorization enforcement (designed for, not built).
- Production hardening (secrets manager, real CA, HA Postgres, observability).
- User self-service/account management beyond first-login provisioning.

## 11. Success criteria

Running `docker compose up` (after `mkcert` setup and `.env` with Google creds) yields:
1. `https://app-whoami.lvh.me` redirects an unauthenticated user to Google.
2. After Google login, the user lands back on `app-whoami` and sees their `X-Auth-*` identity headers rendered.
3. `https://hub.lvh.me` shows a dashboard listing the `whoami` app; clicking it opens the app already authenticated.
4. Postgres contains separate `hub` and `whoami` databases with distinct owners.
```
