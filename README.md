# GRMCApps

A locally-run "apps hub": a Traefik reverse proxy gates independent app
containers behind Google-OIDC login handled by a Fastify hub, backed by a
single Postgres with one database per app.

## Prerequisites

- Docker + Docker Compose
- [mkcert](https://github.com/FiloSottile/mkcert)
- A Google OAuth 2.0 Web client with redirect URI `https://hub.lvh.me/auth/callback`

## Setup

1. **Certificates:**
   ```bash
   mkcert -install
   mkdir -p certs
   mkcert -cert-file certs/_wildcard.lvh.me.pem -key-file certs/_wildcard.lvh.me-key.pem "lvh.me" "*.lvh.me"
   ```
2. **Environment:** `cp .env.example .env`, then fill `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, and the password/secret fields.
3. **Run:** `docker compose up -d --build`

## URLs

- Hub dashboard: https://hub.lvh.me
- whoami app:    https://app-whoami.lvh.me
- Traefik dashboard (local only): http://localhost:8080

## Apps

- **whoami** (`app-whoami.lvh.me`) — validation app echoing identity headers.
- **Social Posts** (`app-social.lvh.me`) — drafts GRMC social posts with Claude,
  pulls Grace Notes / blog from Mailchimp, manages multi-week post series.
  Configure the Anthropic + Mailchimp keys in its Settings tab (stored in the
  `socialposts` database). Source ported from the Apps Script tool in
  `docs/reference/social-posts/`.

## Adding an app

1. Create `apps/<name>/` (its own container listening on port 3000).
2. Add a `<name>` database in `db/init/01-databases.sh`.
3. Add a row to `apps` in `db/init/02-hub-schema.sql` (`slug`, `name`,
   `host` = `app-<name>.lvh.me`).
4. Add a service to `docker-compose.yml` with the Traefik labels and the
   `hub-forward-auth@file` middleware (copy the `whoami` service).
