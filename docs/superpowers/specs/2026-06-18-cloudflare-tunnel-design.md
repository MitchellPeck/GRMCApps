# Cloudflare Tunnel for GRMCApps — Design

**Date:** 2026-06-18
**Status:** Approved (design); pending implementation plan

## Goal

Make the apps (`hub`, `whoami`, `social`, `approvals` under `*.grmc.app`)
reachable from anywhere on the internet — with **no inbound ports opened** and
**no VPN required** — while keeping the same URLs, the same Google OIDC login,
and the same Traefik routing. Today the apps only resolve to a LAN IP, so they
work only on the LAN or over a VPN.

## Decisions (from brainstorming)

- **Access model: full cutover.** Replace the wildcard `A` record with proxied
  (orange-cloud) per-host CNAMEs pointing at the tunnel. Every request — even
  on-LAN — egresses to Cloudflare's edge and returns through the tunnel. One
  consistent path everywhere; accepted tradeoff is added latency for on-LAN
  traffic (it hairpins to the internet).
- **Tunnel management: config-file in repo.** Locally-managed tunnel; ingress
  rules live in a versioned `cloudflared/config.yml`. Matches the existing
  declarative/IaC style (docker-compose, traefik dynamic).
- **Edge auth: rely on existing Google OIDC.** The hub's OIDC + Traefik
  `forwardAuth` remain the only gate. No Cloudflare Access layer.
- **cloudflared auto-updates** via the same Watchtower label as the other app
  containers.

## Architecture

Request flow once deployed:

```
Browser (anywhere)
  -> Cloudflare edge            (public TLS; hostnames proxied / orange-cloud)
  -> Tunnel                     (outbound-only QUIC from the Mac; no inbound ports)
  -> cloudflared container      (joined to hubnet)
  -> https://traefik:443        (SNI = hub.grmc.app, so the LE wildcard cert validates)
  -> Traefik routes by Host()   -> app container
  -> Google OIDC / forwardAuth  (unchanged)
```

`cloudflared` connects to Traefik over HTTPS on the internal Docker network so
traffic stays encrypted end-to-end. Because the Let's Encrypt cert is a wildcard
(`*.grmc.app`), a fixed `originServerName: hub.grmc.app` validates for **every**
host — while cloudflared still forwards the original `Host` header, so Traefik's
per-host routing is unaffected. Let's Encrypt is publicly trusted, so no
`noTLSVerify` and no custom CA pool are needed.

A **single catch-all ingress rule** is sufficient: Traefik does all per-host
routing, so cloudflared just needs to hand everything to `https://traefik:443`
with a `404` fallback.

## Components & Changes

1. **`cloudflared/config.yml`** (committed; contains no secrets)
   - `tunnel: <tunnel-uuid>`
   - `credentials-file: /etc/cloudflared/creds.json`
   - `ingress:`
     - catch-all -> `service: https://traefik:443`, with
       `originRequest.originServerName: hub.grmc.app`
     - final rule -> `service: http_status:404`
   - The tunnel UUID is not a secret and is fine to commit.

2. **`secrets/<tunnel-uuid>.json`** (gitignored, same pattern as the existing
   `secrets/ghcr-auth.json`) — the tunnel credentials produced by
   `cloudflared tunnel create`.

3. **`cloudflared` service added to `docker-compose.remote.yml`** (remote-only,
   alongside Watchtower — the build Mac's plain `docker compose up` must not run
   a tunnel):
   - image `cloudflare/cloudflared:latest`
   - command: `tunnel --config /etc/cloudflared/config.yml run`
   - `networks: [hubnet]`
   - `restart: unless-stopped`
   - volumes: mount `./cloudflared/config.yml` and
     `./secrets/<uuid>.json` -> `/etc/cloudflared/creds.json` (read-only)
   - label `com.centurylinklabs.watchtower.enable=true` for auto-updates
   - `depends_on: traefik` (best-effort; tunnel retries regardless)

4. **DNS cutover in Cloudflare** — replace `A *.grmc.app -> <LAN IP>` (grey)
   with four **proxied** CNAMEs (`hub`, `whoami`, `social`, `approvals`) ->
   `<uuid>.cfargotunnel.com`, created via `cloudflared tunnel route dns`.
   Per-host (not wildcard) because proxied wildcard records are Enterprise-only,
   and there are only four hosts.

## What does NOT change

- Traefik static/dynamic config and all app containers.
- The Let's Encrypt DNS-01 wildcard cert issuance (it now also serves as the
  validated origin cert behind the tunnel).
- Google OIDC client / redirect URI `https://hub.grmc.app/auth/callback`
  (hostnames are identical).
- The `forwardAuth` identity gate.
- Host ports `80`/`443`/`8080` stay mapped (they no longer receive internet
  traffic; only relevant to the build Mac's local dev). Closing them is out of
  scope.

## One-time manual setup (to document in DEPLOY.md)

On the always-on Mac:

1. `cloudflared tunnel login` (browser auth; writes `cert.pem`).
2. `cloudflared tunnel create grmc` -> prints the tunnel UUID and writes
   `<uuid>.json`.
3. Move credentials into the repo: `cp <uuid>.json secrets/`.
4. Put the UUID into `cloudflared/config.yml`.
5. `cloudflared tunnel route dns grmc hub.grmc.app` (repeat for `whoami`,
   `social`, `approvals`) — creates the proxied CNAMEs. Remove the old
   `A *.grmc.app` record.
6. `docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d`.

## Verification

- From a device **off** the LAN/VPN (e.g. a phone on cellular), load
  `https://hub.grmc.app`: Google login appears, and a gated app
  (e.g. `https://whoami.grmc.app`) loads after auth.
- `docker compose logs -f cloudflared` shows the tunnel registered and
  connections served.
- Confirm the four hostnames resolve to Cloudflare (proxied) addresses, not the
  LAN IP.

## Out of scope

- Cloudflare Access / Zero Trust policies.
- Removing host port mappings or any Traefik changes.
- Hybrid split-DNS (keeping a LAN-direct fast path).
