# Network Access Groundwork — Design Spec

**Date:** 2026-06-10
**Status:** Approved (pending final spec review)
**Supersedes the access model in:** `docs/superpowers/specs/2026-06-10-apps-hub-design.md` (the `lvh.me` + mkcert, single-machine assumption).

## 1. Purpose

The hub is meant to run on one Docker host on a local network and be usable by **every device on that network** and by **people who tunnel in (VPN)**. The current groundwork is single-machine only: it uses `*.lvh.me` (hard-pinned to `127.0.0.1`) and an mkcert cert trusted only on the host. This change replaces that with a real domain, publicly-trusted TLS, and DNS that resolves to the host's reachable LAN IP — so any device "just works" with no per-device setup — while making the domain a single configurable knob.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Domain | Dedicated **`grmc.app`**, registered/managed on **Cloudflare** (isolated from the church's existing website/email DNS) |
| DNS for app hosts | Wildcard `A` record `*.grmc.app` → the Docker host's **LAN IP**, **DNS-only (grey cloud)** |
| TLS | Real **Let's Encrypt wildcard `*.grmc.app`** via **DNS-01 challenge through Cloudflare** (host need not be internet-exposed); mkcert removed |
| Hosts | `hub.grmc.app`, plus one subdomain per app (`whoami.grmc.app`, `social.grmc.app`) |
| Domain config | Single `BASE_DOMAIN` env var drives Traefik labels, hub URLs, and cookie domain |
| App registry | Domain-agnostic: store a `subdomain` per app; the hub computes `host = <subdomain>.${BASE_DOMAIN}` |
| Reachability for remote users | Their existing VPN/tunnel into the LAN (out of scope to build); the LAN IP is reachable over it |

`.app` is on the HSTS preload list, so browsers force HTTPS on all `*.grmc.app` — consistent with our all-HTTPS + real-cert setup (and the reason a locally-trusted mkcert cert could never have worked across devices).

## 3. How access works

```
device on LAN / VPN ──resolves social.grmc.app via Cloudflare DNS──► LAN IP (e.g. 192.168.1.50)
   │ (public DNS returns the private IP; only reachable on the LAN or over a tunnel)
   ▼
Docker host :443 ── Traefik (real *.grmc.app LE cert) ── forwardAuth ─► hub ─► app
```

- Cloudflare publishes `*.grmc.app → <host LAN IP>` (DNS-only). Resolving it from anywhere returns the private IP; it only *connects* from the LAN or through a VPN into the LAN. Publishing a private IP is harmless (not internet-routable).
- Traefik obtains and auto-renews a publicly-trusted `*.grmc.app` (+ apex) certificate via Let's Encrypt **DNS-01**, authenticating to Cloudflare with a scoped API token. No inbound internet access required.
- Google OAuth redirects to `https://hub.grmc.app/auth/callback`.

## 4. Repository changes

### 4.1 Traefik (TLS: mkcert → Let's Encrypt DNS-01)
- `traefik/traefik.yml`: add a cert resolver:
  ```yaml
  certificatesResolvers:
    le:
      acme:
        email: ${ACME_EMAIL}
        storage: /letsencrypt/acme.json
        dnsChallenge:
          provider: cloudflare
          resolvers: ["1.1.1.1:53", "8.8.8.8:53"]
  ```
  Keep entrypoints (80→443 redirect) and the Docker + file providers.
- Remove `traefik/dynamic/tls.yml` (the mkcert static cert). Keep `traefik/dynamic/middlewares.yml` (forwardAuth) unchanged.
- `docker-compose.yml` traefik service: add `environment: CF_DNS_API_TOKEN`, `ACME_EMAIL`; add a `letsencrypt` named volume mounted at `/letsencrypt`; remove the `./certs:/certs:ro` mount.
- The **hub** router requests the wildcard once (Traefik then serves it for every `*.grmc.app` SNI):
  ```
  traefik.http.routers.hub.tls.certresolver=le
  traefik.http.routers.hub.tls.domains[0].main=${BASE_DOMAIN}
  traefik.http.routers.hub.tls.domains[0].sans=*.${BASE_DOMAIN}
  ```
  Other apps keep `tls=true` (no per-router resolver needed — Traefik matches the wildcard cert).

### 4.2 Domain via `BASE_DOMAIN` (env-driven)
- `.env` / `.env.example`: `BASE_DOMAIN=grmc.app`, `ACME_EMAIL=<you@…>`, `CF_DNS_API_TOKEN=<scoped token>`. **Remove** `HUB_PUBLIC_URL` and `COOKIE_DOMAIN` (now derived). `.env` already gitignored; the token/email are secrets (only `.env.example` placeholders are committed).
- `docker-compose.yml`: all `Host(...)` rules become env-interpolated, e.g. `Host(\`hub.${BASE_DOMAIN}\`)`, `Host(\`whoami.${BASE_DOMAIN}\`)`, `Host(\`social.${BASE_DOMAIN}\`)`.

### 4.3 Hub config derives URLs from `BASE_DOMAIN`
- `hub/src/config.ts`: take `BASE_DOMAIN`; derive `publicUrl = \`https://hub.${BASE_DOMAIN}\``, `cookieDomain = \`.${BASE_DOMAIN}\``, `google.redirectUri = \`${publicUrl}/auth/callback\``. Drop the `HUB_PUBLIC_URL`/`COOKIE_DOMAIN` reads.

### 4.4 Domain-agnostic app registry
- **Schema:** `apps` table replaces `host text` with `subdomain text` (unique). Seed: `whoami → 'whoami'`, `social-posts → 'social'`.
- **Hub code:** add `BASE_DOMAIN` to config; the registry layer exposes the computed host. `getAppByHost(host)` becomes `getAppBySubdomain(subdomain)`; `/auth/verify` derives the subdomain from `X-Forwarded-Host` by stripping the `.${BASE_DOMAIN}` suffix (reject if it doesn't match the base domain), then looks up the app. The dashboard links to `https://<subdomain>.${BASE_DOMAIN}/`.
- **Migration (running DB):** init scripts only run on a fresh volume, so add a one-off migration against the live `hub` DB: `ALTER TABLE apps ADD COLUMN subdomain text;` backfill (`whoami`→`whoami`, `social-posts`→`social`), `NOT NULL` + `UNIQUE`, drop `host`. Update `db/init/02-hub-schema.sql` to the new shape for fresh setups.

### 4.5 Google OAuth
- The redirect URI is now `https://hub.grmc.app/auth/callback` (derived from `BASE_DOMAIN`). You add this URI to the existing Google OAuth client (you can keep the old `hub.lvh.me` one during transition). No code change beyond 4.3.

## 5. Your one-time prerequisites (deploy-time)

1. Register **`grmc.app`** on Cloudflare (or add it as a Cloudflare zone).
2. Create a **scoped API token** (Zone → DNS → Edit, for `grmc.app`) → `CF_DNS_API_TOKEN`.
3. Add DNS in Cloudflare: `A  *.grmc.app  → <Docker host LAN IP>`, **DNS-only** (grey cloud). (Optionally `A hub.grmc.app` explicitly — the wildcard already covers it.)
4. Give the Docker host a **static IP / DHCP reservation** so the A record stays valid.
5. Add `https://hub.grmc.app/auth/callback` to the Google OAuth client's authorized redirect URIs.
6. Set `BASE_DOMAIN`, `ACME_EMAIL`, `CF_DNS_API_TOKEN` in `.env`.

## 6. Error handling & operational notes

- If the Cloudflare token is missing/wrong, Traefik logs an ACME/DNS error and serves its default self-signed cert; the fix is the token (surfaced in `docker compose logs traefik`).
- `acme.json` lives in the `letsencrypt` volume (persists across restarts; auto-renew handled by Traefik). Don't commit it.
- Let's Encrypt is rate-limited; one wildcard issuance is well within limits. Use the LE staging directory first only if iterating heavily (optional).

## 7. Testing

- **Local/config (automatable now):** compose interpolates `BASE_DOMAIN` into the labels (`docker compose config` shows `Host(\`hub.grmc.app\`)`); Traefik starts and loads the `le` resolver without config errors; the hub builds `publicUrl`/`cookieDomain`/`redirectUri` from `BASE_DOMAIN`; the registry resolves app hosts from `BASE_DOMAIN` + `subdomain`; `/auth/verify` derives the subdomain correctly (unit-testable: `social.grmc.app` → `social`).
- **Real cert + cross-device (gated on your setup):** once `grmc.app` is on Cloudflare with the token + A record, Traefik issues the real `*.grmc.app` cert; verify from a second device on the LAN (and over the VPN) that `https://hub.grmc.app` loads with a trusted cert and Google login completes. Same "needs external setup" boundary as the Google OAuth client.

## 8. Out of scope

- Building/operating the VPN itself (uses your existing tunnel; the LAN IP is reachable over it).
- The Metricool integration (separate feature, brainstormed next — its Google-OAuth-adjacent concerns are unaffected by this change).
- Exposing the hub to the public internet (intentionally LAN/VPN-only).
- A local-dev `lvh.me`/mkcert fallback (single model: real domain + LE; for pure-local testing one can add a hosts entry, not part of this spec).

## 9. Success criteria

1. `docker compose config` shows the app routers as `Host(\`hub.grmc.app\`)`, `Host(\`whoami.grmc.app\`)`, `Host(\`social.grmc.app\`)`.
2. With the Cloudflare token + domain in place, Traefik serves a **publicly-trusted** `*.grmc.app` cert (no warnings on a fresh device).
3. A second device on the LAN (and a VPN client) can open `https://hub.grmc.app`, log in via Google, and open the apps — no per-device CA install.
4. The `apps` registry stores subdomains (not full hosts); changing `BASE_DOMAIN` alone re-points every host, with no DB edit.
5. forwardAuth still gates each app: unauthenticated `https://social.grmc.app` → 302 to `https://hub.grmc.app/auth/login?redirect=…`.
