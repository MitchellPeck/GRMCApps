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
5. Point the app hosts at the tunnel — this creates **proxied** CNAMEs and is
   what makes them reachable from the internet:
   ```bash
   cloudflared tunnel route dns grmc hub.grmc.app
   cloudflared tunnel route dns grmc whoami.grmc.app
   cloudflared tunnel route dns grmc social.grmc.app
   cloudflared tunnel route dns grmc approvals.grmc.app
   cloudflared tunnel route dns grmc minutes.grmc.app
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

**Watchtower only updates app _images_ — it cannot apply compose changes.** New
services, a changed image or port, new env vars, new `db/init/` scripts,
`traefik/dynamic/` edits: none of these reach the host until someone re-applies
the compose files there. (This is exactly why adding the `whisper` service broke
transcription: Watchtower updated the `meeting-minutes` app to point at
`whisper:9000`, but the `whisper` container itself was never created — only a
`compose up` does that.)

So after any infra change, the host must run:

```bash
# on the always-on Mac
git pull
docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d
```

### Automate it (so you don't have to be onsite)

`scripts/auto-deploy.sh` does exactly the above, but only when the deploy branch
actually moved. Install it once on the host as a launchd agent so compose
changes apply themselves within a few minutes — no need to be in front of the
machine:

```bash
# on the always-on Mac, once
./scripts/install-autodeploy.sh            # runs every 5 min; RunAtLoad too
# GRMC_DEPLOY_INTERVAL=120 ./scripts/install-autodeploy.sh   # custom cadence
./scripts/install-autodeploy.sh --uninstall
```

It fast-forwards `main`, `docker compose pull`s, and `up -d`s (removing
orphans). It's a LaunchAgent (not a system daemon) on purpose: Docker Desktop
runs in your user session, so the Mac must be set to **auto-login** for the
agent — and Docker — to be running after a reboot. Logs land in
`auto-deploy.log` (and `auto-deploy.launchd.log`) at the repo root.

> Watchtower and auto-deploy are complementary: Watchtower ships app-image
> updates fast (every 2 min); auto-deploy applies structural compose changes.
> All long-running services also carry `restart: unless-stopped`, so a crash or
> a Docker/host restart brings them back on its own.

---

## Handy checks

```bash
docker compose logs -f watchtower     # on the remote: watch auto-updates happen
docker compose ps                     # see what's running
```
