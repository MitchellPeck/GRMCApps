# Cloudflare Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cloudflare Tunnel so `*.grmc.app` apps are reachable from anywhere with no inbound ports and no VPN, keeping the same URLs, Google OIDC login, and Traefik routing.

**Architecture:** A `cloudflared` container (remote-only, on `hubnet`) holds an outbound-only tunnel to Cloudflare's edge and forwards all traffic to `https://traefik:443`. Traefik continues all per-host routing and origin TLS using the existing Let's Encrypt wildcard cert; cloudflared validates that cert via a fixed `originServerName`. DNS for the four hosts becomes proxied CNAMEs to the tunnel.

**Tech Stack:** `cloudflare/cloudflared`, Docker Compose, Traefik v3, Cloudflare DNS.

---

## File Structure

- **Create `cloudflared/config.yml`** — tunnel ingress config (committed; no secrets). One catch-all rule to Traefik + 404 fallback.
- **Modify `docker-compose.remote.yml`** — add the `cloudflared` service (remote-only, alongside Watchtower).
- **Modify `DEPLOY.md`** — document the one-time tunnel setup, the DNS cutover, and the per-host operational notes.
- **Modify `README.md`** — update the "reachable on LAN / over VPN" framing to "reachable anywhere via Cloudflare Tunnel".
- **`secrets/cloudflared-creds.json`** — tunnel credentials, gitignored (operator-supplied during one-time setup; not created by these tasks).

Note: this work is mostly declarative config + docs. There is no unit-test harness; "tests" here are config validation (`docker compose config`) and an operator-run off-LAN smoke test. Keep commits small.

---

### Task 1: Tunnel ingress config

**Files:**
- Create: `cloudflared/config.yml`

- [ ] **Step 1: Create the config file**

Create `cloudflared/config.yml` with exactly this content. `<TUNNEL_UUID>` is filled in during Task 5 (the operator runs `cloudflared tunnel create`, which prints it); it is a tunnel identifier, not a secret.

```yaml
# Cloudflare Tunnel ingress for GRMCApps.
# Locally-managed (config-file) tunnel. Runs only on the always-on Mac via the
# cloudflared service in docker-compose.remote.yml.
#
# All public hostnames (hub/whoami/social/approvals.grmc.app) are handed to
# Traefik, which does the per-host routing. cloudflared connects over HTTPS on
# the internal Docker network; originServerName pins SNI to a name covered by
# the Let's Encrypt *.grmc.app wildcard cert so the origin cert validates,
# while the original Host header is preserved for Traefik routing.
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/creds.json

ingress:
  - service: https://traefik:443
    originRequest:
      originServerName: hub.grmc.app
  - service: http_status:404
```

- [ ] **Step 2: Validate it is well-formed YAML**

Run: `docker run --rm -v "$PWD/cloudflared/config.yml:/c.yml:ro" mikefarah/yq:latest '.ingress | length' /c.yml`
Expected: prints `2` (two ingress rules). If `yq`/Docker is unavailable, instead run `python3 -c "import yaml,sys;print(len(yaml.safe_load(open('cloudflared/config.yml'))['ingress']))"` and expect `2`.

- [ ] **Step 3: Commit**

```bash
git add cloudflared/config.yml
git commit -m "feat(tunnel): add cloudflared ingress config"
```

---

### Task 2: cloudflared service (remote-only)

**Files:**
- Modify: `docker-compose.remote.yml`

- [ ] **Step 1: Add the cloudflared service**

Append this service under the existing `services:` key in `docker-compose.remote.yml` (after the `watchtower` service), keeping the two-space indentation that file already uses:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    # Outbound-only tunnel to Cloudflare's edge; no inbound ports. Forwards all
    # public hostnames to Traefik (see cloudflared/config.yml). Joined to hubnet
    # so it can reach the traefik service by name.
    command: tunnel --config /etc/cloudflared/config.yml run
    depends_on:
      - traefik
    volumes:
      - ./cloudflared/config.yml:/etc/cloudflared/config.yml:ro
      - ./secrets/cloudflared-creds.json:/etc/cloudflared/creds.json:ro
    networks: [hubnet]
    labels:
      # Auto-update like the app containers (Watchtower runs with LABEL_ENABLE).
      - "com.centurylinklabs.watchtower.enable=true"
```

- [ ] **Step 2: Validate the merged compose config parses**

Run: `docker compose -f docker-compose.yml -f docker-compose.remote.yml config --services`
Expected: lists the services and includes `cloudflared` (no YAML/interpolation errors). The credentials file need not exist yet for this to pass.

- [ ] **Step 3: Confirm cloudflared joins hubnet and mounts the config**

Run: `docker compose -f docker-compose.yml -f docker-compose.remote.yml config | grep -A20 'cloudflared:'`
Expected: output shows the `command`, both volume mounts, and `hubnet` under networks.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.remote.yml
git commit -m "feat(tunnel): add remote-only cloudflared service"
```

---

### Task 3: Document the deploy procedure

**Files:**
- Modify: `DEPLOY.md`

- [ ] **Step 1: Add a Cloudflare Tunnel section to DEPLOY.md**

Insert this section in `DEPLOY.md` immediately after the `### On the other Mac (the always-on host)` subsection (before `## When you change infra, not app code`):

````markdown
### Cloudflare Tunnel (remote access from anywhere)

The tunnel lets every `*.grmc.app` host be reached from anywhere with no inbound
ports and no VPN. It runs only on the always-on Mac (it's defined in
`docker-compose.remote.yml`). One-time setup, on that Mac:

1. Authenticate cloudflared (opens a browser; pick the `grmc.app` zone):
   ```bash
   cloudflared tunnel login
   ```
2. Create the tunnel — note the UUID it prints, and the `<UUID>.json` it writes
   (usually under `~/.cloudflared/`):
   ```bash
   cloudflared tunnel create grmc
   ```
3. Put the credentials where the container expects them (gitignored):
   ```bash
   mkdir -p secrets
   cp ~/.cloudflared/<UUID>.json secrets/cloudflared-creds.json
   ```
4. Set the UUID in `cloudflared/config.yml` (replace `<TUNNEL_UUID>`).
5. Point the four hosts at the tunnel — this creates **proxied** CNAMEs and is
   what makes them reachable from the internet:
   ```bash
   cloudflared tunnel route dns grmc hub.grmc.app
   cloudflared tunnel route dns grmc whoami.grmc.app
   cloudflared tunnel route dns grmc social.grmc.app
   cloudflared tunnel route dns grmc approvals.grmc.app
   ```
6. In the Cloudflare dashboard, **delete the old `A  *.grmc.app → <LAN IP>`
   record** (the new per-host CNAMEs take over; the wildcard A is the LAN-only
   path being retired).
7. Start/refresh the stack so cloudflared comes up:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d
   ```

Verify (from a device **off** the LAN/VPN, e.g. a phone on cellular): load
`https://hub.grmc.app`, sign in with Google, then open `https://whoami.grmc.app`.
Check the tunnel with `docker compose logs -f cloudflared` (should show it
registered and serving connections).

> The DNS-01 wildcard cert keeps working exactly as before — it's now also the
> origin cert cloudflared validates. Google OIDC is unchanged (same hostnames).
````

- [ ] **Step 2: Verify the section reads correctly**

Run: `grep -n "Cloudflare Tunnel (remote access" DEPLOY.md`
Expected: one matching line.

- [ ] **Step 3: Commit**

```bash
git add DEPLOY.md
git commit -m "docs: document Cloudflare Tunnel setup and DNS cutover"
```

---

### Task 4: Update README framing

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the intro paragraph**

In `README.md`, replace this sentence in the opening paragraph:

```
It runs on one Docker host and is
reachable by every device on the local network — and by anyone tunneling in
over a VPN — with real, publicly-trusted HTTPS and no per-device setup.
```

with:

```
It runs on one Docker host and is reachable from anywhere via a Cloudflare
Tunnel (outbound-only; no inbound ports, no VPN), with real, publicly-trusted
HTTPS and no per-device setup.
```

- [ ] **Step 2: Update the DNS setup step**

In `README.md`, replace setup step 1 (the `**DNS (Cloudflare):**` bullet) with:

```
1. **DNS (Cloudflare):** the four app hosts (`hub`, `whoami`, `social`,
   `approvals`) are **proxied CNAMEs** to the Cloudflare Tunnel, created by
   `cloudflared tunnel route dns` (see DEPLOY.md → *Cloudflare Tunnel*). This
   replaces the old LAN-only `A  *.grmc.app → <host LAN IP>` record.
```

- [ ] **Step 3: Update the closing line about LAN/VPN reach**

In `README.md`, replace:

```
Every host below then loads with trusted HTTPS on any device on the LAN (or over
a VPN), with no per-device certificate install.
```

with:

```
Every host below then loads with trusted HTTPS from anywhere through the
Cloudflare Tunnel, with no per-device certificate install.
```

- [ ] **Step 4: Verify the edits landed**

Run: `grep -n "Cloudflare Tunnel" README.md`
Expected: at least the intro and DNS-step references appear.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: README reflects Cloudflare Tunnel remote access"
```

---

### Task 5: Operator deployment + smoke test (manual, on the always-on Mac)

This task is run by the operator on the always-on Mac — it requires Cloudflare
browser auth and the live host, so it cannot be done by an agent in this repo.
Follow `DEPLOY.md → Cloudflare Tunnel` steps 1–7 (login → create → copy creds →
set UUID in `cloudflared/config.yml` → `route dns` ×4 → delete old `A` record →
`up -d`).

- [ ] **Step 1: Bring up the tunnel** — run the DEPLOY.md steps; commit the
  filled-in `cloudflared/config.yml` (the UUID is not a secret):
  ```bash
  git add cloudflared/config.yml
  git commit -m "chore(tunnel): set grmc tunnel UUID"
  ```
- [ ] **Step 2: Confirm the tunnel is healthy** —
  `docker compose -f docker-compose.yml -f docker-compose.remote.yml logs cloudflared`
  shows it registered connections to the edge.
- [ ] **Step 3: Off-LAN smoke test** — from a device not on the LAN/VPN, load
  `https://hub.grmc.app`, sign in with Google, then open `https://whoami.grmc.app`
  and confirm it loads behind auth.
- [ ] **Step 4: Confirm DNS** — `dig +short hub.grmc.app` returns Cloudflare
  proxy addresses (not the LAN IP).

---

## Self-Review Notes

- **Spec coverage:** config-file tunnel (Task 1), remote-only cloudflared service with Watchtower label and `https://traefik:443` + `originServerName` (Task 2), DNS cutover to proxied per-host CNAMEs and one-time setup (Task 3 + Task 5), README/DEPLOY docs (Tasks 3–4), off-LAN verification (Task 5). "What does not change" (Traefik/apps/OIDC/cert) is honored — no tasks touch those. Cloudflare Access and host-port removal are out of scope per the spec and have no tasks.
- **Placeholders:** the only `<...>` tokens are `<TUNNEL_UUID>` / `<UUID>`, which are operator-supplied runtime identifiers with explicit fill-in steps — not unspecified plan content.
- **Consistency:** credentials path is `secrets/cloudflared-creds.json` → mounted at `/etc/cloudflared/creds.json` in both the compose service (Task 2) and `credentials-file` in config.yml (Task 1); compose flags `-f docker-compose.yml -f docker-compose.remote.yml` are used consistently.
