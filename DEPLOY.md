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

> Replacing an existing always-on Mac? Skip this and use *Moving the stack to
> a new Mac* below — it carries the data, secrets and tunnel over.

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

## Moving the stack to a new Mac

Everything that makes the always-on Mac *the* host is either gitignored
(`.env`, `secrets/`), an uncommitted local edit (`cloudflared/config.yml`
carries the real tunnel UUID), or a Docker volume (`pgdata` — every app's
database; `minutesdata` — meeting recordings; `letsencrypt` and `whisperdata` —
regenerable, but cheap to carry). Nothing in Cloudflare, Google or GHCR is tied
to the machine: the tunnel follows its credentials file, the DNS routes point
at the tunnel, and the OAuth client only knows the hostnames. So a move is
"snapshot those pieces, restore them on the new Mac, wipe the old one". Two
scripts do it. Expect a few minutes of downtime while the bundle moves.

### 0. Prepare the new Mac

- Install Docker Desktop, open it once, and turn on *Settings → General → Start
  Docker Desktop when you sign in*.
- Clone the repo into a folder named **`GRMCApps`** — Traefik expects the Compose
  project name `grmcapps`, which Compose derives from the folder name:
  ```bash
  git clone https://github.com/MitchellPeck/GRMCApps.git GRMCApps
  ```
- Make it a real always-on host: automatic login for this user (Docker Desktop
  and the auto-deploy agent run in the user session), no sleep, and a DHCP
  reservation / static IP as before.
- Nothing else: no `cloudflared` CLI, no Cloudflare or Google changes.

### 1. On the old Mac — export

```bash
./scripts/migrate-export.sh              # writes ~/grmc-migration-<stamp>.tar
# ./scripts/migrate-export.sh --out /Volumes/USB/grmc.tar   # elsewhere
```

It removes the auto-deploy agent, takes a `pg_dumpall` (kept as a fallback),
**stops the stack** — downtime starts here — tars the four volumes, and bundles
them with `.env`, `secrets/` and the tunnel config. Nothing is deleted: to roll
back, `docker compose -f docker-compose.yml -f docker-compose.remote.yml start`
and `./scripts/install-autodeploy.sh`.

The bundle contains secrets and all app data. Move it privately (scp, AirDrop, a
USB drive) and delete it when you are done.

### 2. On the new Mac — import

```bash
cd GRMCApps
./scripts/migrate-import.sh ~/grmc-migration-<stamp>.tar
```

It refuses to run over an existing install (`--force` overrides, for a redo).
Then it restores the files and volumes, logs the `docker` CLI into GHCR with the
PAT already in `secrets/ghcr-auth.json` (a fresh host can't pull the private
images otherwise), `compose up`s with both files, installs the auto-deploy
agent, and waits for `https://hub.grmc.app` to answer through the tunnel.

Verify from a phone **off** Wi-Fi: open the hub, sign in with Google, open
whoami and Meeting Minutes and check the data is there. That exercises the
tunnel, TLS, OIDC and the restored volumes in one go.

If Postgres refuses to start from the copied volume (it shouldn't — same
architecture, same major version, clean shutdown), fall back to the SQL dump in
the bundle: start a fresh database and load it. "already exists" errors for the
roles, databases and hub tables are expected — the init scripts created those.

```bash
C="docker compose -f docker-compose.yml -f docker-compose.remote.yml"
$C down && docker volume rm grmcapps_pgdata
$C up -d --wait postgres
tar -xOf ~/grmc-migration-<stamp>.tar '*/pg_dumpall.sql.gz' | gunzip | $C exec -T postgres psql -U postgres
$C up -d
```

### 3. On the old Mac — purge

Only once step 2 is verified:

```bash
./scripts/migrate-export.sh --purge
```

It asks for confirmation, then removes the containers, images and volumes,
`.env`, `secrets/` and the agent, and resets `cloudflared/config.yml`. After
that the folder can go, and Docker Desktop too if nothing else uses it.

### What does not change

The Cloudflare tunnel and DNS, the Google OAuth client, the GHCR packages, and
the build-and-push flow from your Mac. Watchtower resumes on the new host with
the same credentials file.

---

## Handy checks

```bash
docker compose logs -f watchtower     # on the remote: watch auto-updates happen
docker compose ps                     # see what's running
```
