# GRMCApps

A self-hosted "apps hub": a Traefik reverse proxy gates independent app
containers behind Google-OIDC login handled by a Fastify hub, backed by a
single Postgres with one database per app. It runs on one Docker host and is
reachable from anywhere via a Cloudflare Tunnel (outbound-only; no inbound
ports, no VPN), with real, publicly-trusted HTTPS and no per-device setup.

## Prerequisites

- Docker + Docker Compose
- A dedicated domain on **Cloudflare** (this project uses `grmc.app`)
- A Cloudflare API token scoped to **Zone → DNS → Edit** for that zone
- A Google OAuth 2.0 Web client with redirect URI `https://hub.grmc.app/auth/callback`
- The Docker host on a **static IP / DHCP reservation**

## Setup

1. **DNS (Cloudflare):** the four app hosts (`hub`, `whoami`, `social`,
   `approvals`) are **proxied CNAMEs** to the Cloudflare Tunnel, created by
   `cloudflared tunnel route dns` (see DEPLOY.md → *Cloudflare Tunnel*). This
   replaces the old LAN-only `A  *.grmc.app → <host LAN IP>` record.
2. **Environment:** `cp .env.example .env`, then set `BASE_DOMAIN` (`grmc.app`),
   `ACME_EMAIL` (a real address — Let's Encrypt rejects `example.com`),
   `CF_DNS_API_TOKEN`, the `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, and the
   password/secret fields.
3. **Run:** `docker compose up -d --build` — Traefik obtains a trusted
   `*.grmc.app` certificate from Let's Encrypt via the Cloudflare DNS-01
   challenge (no inbound internet access required).

Every host below then loads with trusted HTTPS from anywhere through the
Cloudflare Tunnel, with no per-device certificate install.

> The domain is driven entirely by `BASE_DOMAIN`. Hosts are `hub.<BASE_DOMAIN>`
> and `<subdomain>.<BASE_DOMAIN>` per app; changing `BASE_DOMAIN` re-points
> everything with no other edits.

## URLs

- Hub dashboard: https://hub.grmc.app
- whoami app:    https://whoami.grmc.app
- Social Posts:  https://social.grmc.app
- Approvals:     https://approvals.grmc.app
- Traefik dashboard (host-local only): http://localhost:8080

## Apps

- **whoami** (`whoami.grmc.app`) — validation app echoing identity headers.
- **Social Posts** (`social.grmc.app`) — drafts GRMC social posts with Claude,
  pulls Grace Notes / blog from Mailchimp, manages multi-week post series.
  Configure the Anthropic + Mailchimp keys in its Settings tab (stored in the
  `socialposts` database). Source ported from the Apps Script tool in
  `docs/reference/social-posts/`. Send drafted posts straight to Metricool as scheduled drafts (Settings → Metricool: API token + User ID + Blog ID via 'Load brands'), optionally attaching an **approved graphic from the Approvals app** — published to a public Cloudflare R2 URL so Metricool can fetch it (Settings → Image hosting). Requires the Metricool Advanced plan.
- **Approvals** (`approvals.grmc.app`) — request and grant sign-off on graphics.
  Submitters upload an image and pick an approver from a roster (managed in
  Settings); the approver approves, rejects, or requests changes. Change
  requests bounce back to the submitter, who uploads a new version. Every
  version and decision is kept; data and image bytes live in the `approvals`
  database.

## Adding an app

1. Create `apps/<name>/` (its own container listening on port 3000).
2. Add a `<name>` database in `db/init/01-databases.sh`.
3. Add a row to `apps` in `db/init/02-hub-schema.sql` (`slug`, `name`,
   `subdomain` = `<name>`), which the hub serves at `<name>.${BASE_DOMAIN}`.
4. Add a service to `docker-compose.yml` with the Traefik labels —
   ``Host(`<name>.${BASE_DOMAIN}`)``, `tls=true`, and the
   `hub-forward-auth@file` middleware (copy the `whoami` service).
