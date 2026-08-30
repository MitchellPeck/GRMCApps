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

> Moving an existing installation to another Mac? See DEPLOY.md → *Moving the
> stack to a new Mac* — it carries the data, secrets and tunnel over instead of
> starting fresh.

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
- Meeting Minutes: https://minutes.grmc.app
- Traefik dashboard (host-local only): http://localhost:8080

## Apps

Every app shares one design system (`shared/ui/grmc.css`) and one header:
the wordmark links back to the hub and an **Apps** switcher jumps straight
between apps. Both are served to each app at `/assets/` (see *Shared UI* below).

- **whoami** (`whoami.grmc.app`) — validation app echoing identity headers.
- **Social Posts** (`social.grmc.app`) — drafts GRMC social posts with Claude,
  pulls Grace Notes / blog from Mailchimp, manages multi-week post series. Two
  runs: **Wednesday** (Grace Notes post + Saturday invite) and **Friday** (weekly
  blog post). Configure the Anthropic + Mailchimp keys in its Settings tab
  (stored in the `socialposts` database). Source ported from the Apps Script
  tool in `docs/reference/social-posts/`. Send drafted posts straight to
  Metricool as scheduled drafts on Facebook, Instagram and X (Settings →
  Metricool: API token + User ID + Blog ID via 'Load brands'). A post with an
  associated weekday opens the scheduler on that day of the current week. You
  can attach an image by **uploading one** or by picking an **approved graphic
  from the Approvals app** — either is published to a public Cloudflare R2 URL
  so Metricool can fetch it (Settings → Image hosting). Requires the Metricool
  Advanced plan.
- **Approvals** (`approvals.grmc.app`) — request and grant sign-off on graphics.
  Submitters upload an image and pick an approver from a roster (managed in
  Settings); the approver approves, rejects, or requests changes. Change
  requests bounce back to the submitter, who uploads a new version. Every
  version and decision is kept; data and image bytes live in the `approvals`
  database.
- **Meeting Minutes** (`minutes.grmc.app`) — run a meeting end-to-end and get
  AI minutes. Maintain a reusable **library of people**; create a **meeting**,
  **upload its agenda** (PDF, image, or text) which Claude extracts into an
  ordered list of items, and pick which people are **present**. Then work down
  the agenda: for each item choose the presenter(s), **record** the discussion
  (or upload a recording) — on stop it is transcribed **with speaker
  diarization**, labeling who is speaking; you map each detected voice to an
  attendee (auto-mapped when there's a single speaker and one presenter). Add
  optional typed notes, then **summarize** the item — Claude writes the minutes
  and **infers action items** from natural phrasing ("we need to…", "Bob will
  follow up…"), each with an owner. Finally **generate a report**: full minutes
  with per-item summaries and one consolidated, owner-attributed action-item
  checklist. Transcription runs on a **self-hosted Whisper service** with
  diarization (the `whisper` container) — no API key, no per-minute cost, and
  audio never leaves the host. Add only the Anthropic key (for
  extraction/summaries/report) in Settings; everything is stored in the
  `meetingminutes` database.
  
  Transcription speed is tuned through the `whisper` service in
  `docker-compose.yml`, and every value can be overridden from `.env` without a
  rebuild: `WHISPER_MODEL` (default `small.en`), `WHISPER_THREADS` (default
  `6`, sized for an 8-core host), `WHISPER_BEAM` (default `1`, greedy),
  `WHISPER_COMPUTE_TYPE` (default `int8`), and `WHISPER_DIARIZE_THRESHOLD`
  (default `0.7` — raise it if one person is still split across several
  speakers, lower it if two people are being merged). Changing `WHISPER_MODEL`
  triggers a one-time model download into the `whisperdata` volume, so the
  first transcription after that change is slow.

## Adding an app

1. Create `apps/<name>/` (its own container listening on port 3000).
2. Add a `<name>` database in `db/init/01-databases.sh`.
3. Add a row to `apps` in `db/init/02-hub-schema.sql` (`slug`, `name`,
   `subdomain` = `<name>`), which the hub serves at `<name>.${BASE_DOMAIN}`.
4. Add a service to `docker-compose.yml` with the Traefik labels —
   ``Host(`<name>.${BASE_DOMAIN}`)``, `tls=true`, and the
   `hub-forward-auth@file` middleware (copy the `whoami` service).
5. Copy the shared UI into the image and load it on the page (see below). The
   app then appears in every other app's switcher automatically.

## Shared UI

`shared/ui/` is the single source of truth for how the apps look and how you
move between them:

- `grmc.css` — design tokens and the shared component vocabulary (header,
  tabs, cards, forms, buttons, alerts, badges).
- `grmc-nav.js` — links the header wordmark home to the hub and injects the
  **Apps** switcher. It reads the live registry from the hub's `/api/apps`
  (session-authenticated, and readable only from our own subdomains), falling
  back to a built-in list if the hub is unreachable.

Each app's Dockerfile copies both into `src/public/assets/`, and each page
loads `/assets/grmc.css` plus `/assets/grmc-nav.js`. The switcher needs no
per-app configuration: it derives the base domain from the host it is served
from, and marks the current app by matching its subdomain.
