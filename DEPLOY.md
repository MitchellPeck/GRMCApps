# Deploying updates to the remote Mac

Images are built on **your Mac**, pushed to **GHCR** (GitHub Container Registry,
namespace `ghcr.io/mitchellpeck`), and the **other Mac** auto-pulls them via
Watchtower. App code updates are fully automatic; infra/config changes need a
`git pull` on the remote.

---

## Each time you want to ship an update (your Mac)

From the project folder:

```bash
docker compose build      # bake your latest code into images
docker compose push       # upload them to ghcr.io/mitchellpeck/grmc-*
```

That's it. Within ~2 minutes Watchtower on the other Mac pulls the new images
and restarts those apps. You do nothing on the other machine.

> Both Macs are Apple Silicon (arm64), so a plain `build` produces images that
> run on the remote as-is — no cross-architecture flags needed.

---

## One-time setup

### On your Mac (build/push side)
1. Log in to GHCR (only needed once; paste your PAT at the password prompt):
   ```bash
   docker login ghcr.io -u MitchellPeck
   ```
2. Make sure the four GHCR packages are allowed to exist — the first
   `docker compose push` creates them automatically as **private** packages.

### On the other Mac (the always-on host)
1. Have this repo cloned and a filled-in `.env` (same as your Mac's).
2. Create Watchtower's GHCR credentials file (Docker Desktop keeps your
   `docker login` token in the macOS keychain, which the Watchtower container
   can't read — so it needs its own copy):
   ```bash
   mkdir -p secrets
   AUTH=$(printf 'MitchellPeck:YOUR_PAT_HERE' | base64)
   printf '{\n  "auths": { "ghcr.io": { "auth": "%s" } }\n}\n' "$AUTH" > secrets/ghcr-auth.json
   ```
   (`secrets/` is gitignored, so this never leaves the machine.)
3. Start the stack **with both compose files** so Watchtower runs too:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d
   ```

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

---

## When you change infra, not app code

If you edit `docker-compose.yml`, the `traefik/dynamic/` files, or `db/init/`
scripts (not app source), the remote needs those files too:

```bash
# on the other Mac
git pull
docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d
```

---

## Handy checks

```bash
docker compose logs -f watchtower     # on the remote: watch auto-updates happen
docker compose ps                     # see what's running
```
