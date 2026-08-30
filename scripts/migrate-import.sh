#!/usr/bin/env bash
# Bring the always-on stack UP on this Mac from a bundle written by
# scripts/migrate-export.sh.
#
# Run on the NEW Mac, with Docker Desktop running, from a fresh clone of this
# repo in a folder named GRMCApps (Traefik expects the Compose project name
# `grmcapps`, which Compose derives from the folder name):
#
#   ./scripts/migrate-import.sh ~/grmc-migration-<stamp>.tar [--force]
#
# Order of operations — nothing irreversible happens before the network steps
# succeed: verify the bundle checksum (if its .sha256 sidecar is alongside),
# preflight (refuse over an existing install), unpack, restore .env / secrets /
# the tunnel config, log the docker CLI in to GHCR with the PAT already in
# secrets/ghcr-auth.json, pull every image, THEN restore the volumes, start the
# stack with both compose files, install the auto-deploy agent, and wait for
# the tunnel to answer. A failure before the volumes are restored undoes the
# restored files so a plain re-run works; --force re-imports over a previous
# attempt (asks first — it deletes this Mac's volumes).
# GRMC_MIGRATE_WAIT (seconds, default 120) bounds the final tunnel wait.
# Full runbook: DEPLOY.md → "Moving the stack to a new Mac".
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/migrate-lib.sh
source "$REPO_DIR/scripts/lib/migrate-lib.sh"

export PATH="${PATH:-}:/opt/homebrew/bin:/usr/local/bin"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.remote.yml)
COMPOSE_CMD="docker compose -f docker-compose.yml -f docker-compose.remote.yml"

usage() { echo "Usage: $0 <bundle.tar> [--force]"; }
die() { err "$@"; exit 1; }

BUNDLE=""
FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE="force"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown argument: $1" ;;
    *) [ -z "$BUNDLE" ] || { usage >&2; die "only one bundle, please"; }; BUNDLE="$1"; shift ;;
  esac
done
[ -n "$BUNDLE" ] || { usage >&2; exit 1; }
[ -f "$BUNDLE" ] || die "no such bundle: $BUNDLE"
BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"

cd "$REPO_DIR"
[ -f docker-compose.yml ] && [ -f docker-compose.remote.yml ] || die "run this from the repo root of a full clone"
# Traefik is told the Docker network by name (<project>_hubnet), so the Compose
# project name on this Mac must match what docker-compose.yml expects.
EXPECTED_PROJECT="$(sed -n 's/.*--providers\.docker\.network=\([a-z0-9_-]*\)_hubnet.*/\1/p' docker-compose.yml | head -1)"
EXPECTED_PROJECT="${EXPECTED_PROJECT:-grmcapps}"
PROJECT="$(compose_project_name "$REPO_DIR")"
[ "$PROJECT" = "$EXPECTED_PROJECT" ] || die "the Compose project name here resolves to '$PROJECT', but docker-compose.yml expects '$EXPECTED_PROJECT'. Clone the repo into a folder named GRMCApps (or export COMPOSE_PROJECT_NAME=$EXPECTED_PROJECT) and re-run."
docker info >/dev/null 2>&1 || die "Docker Desktop is not running on this Mac"

if [ -f "$BUNDLE.sha256" ]; then
  echo "==> Verifying $(basename "$BUNDLE") against its .sha256"
  (cd "$(dirname "$BUNDLE")" && shasum -a 256 -c "$(basename "$BUNDLE").sha256" >/dev/null 2>&1) \
    || die "checksum mismatch — the bundle was damaged in transfer; copy it again"
else
  echo "    (no $(basename "$BUNDLE").sha256 alongside the bundle — skipping the integrity check)"
fi

import_preflight "$REPO_DIR" "$PROJECT" "$FORCE"

# Stages drive what a failure undoes: before any volume is restored, put the
# checkout back the way it was so a plain re-run works.
STAGE="start"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/grmc-migration.XXXXXX")"
on_exit() {
  local rc=$?
  rm -rf "$TMP"
  if [ "$rc" -ne 0 ]; then
    case "$STAGE" in
      files)
        rm -f .env secrets/ghcr-auth.json secrets/cloudflared-creds.json
        git checkout -- cloudflared/config.yml 2>/dev/null || true
        echo "Import FAILED before any volume was restored; the restored files were removed again. Fix the error above and re-run." >&2 ;;
      volumes|up)
        echo "Import FAILED after volumes were restored. Fix the error above and re-run with --force (it replaces what was restored)." >&2 ;;
    esac
  fi
  exit "$rc"
}
trap on_exit EXIT

echo "==> Unpacking $(basename "$BUNDLE")"
tar -xf "$BUNDLE" -C "$TMP"
staging="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$staging" ] && [ -f "$staging/MANIFEST" ] || die "not a migration bundle (no MANIFEST inside)"
[ -f "$staging/volumes/pgdata.tgz" ] || die "bundle has no pgdata volume — refusing to start with an empty database"
manifest="$staging/MANIFEST"
echo "    made on $(manifest_get "$manifest" hostname) at $(manifest_get "$manifest" created_at)"
bundle_arch="$(manifest_get "$manifest" arch)"
if [ -n "$bundle_arch" ] && [ "$bundle_arch" != "$(uname -m)" ]; then
  die "the bundle was made on a $bundle_arch machine but this one is $(uname -m). The copied Postgres data directory is architecture-specific — use the pg_dumpall fallback in DEPLOY.md instead of this script's volume restore."
fi
bundle_sha="$(manifest_get "$manifest" git_sha)"
if [ -n "$bundle_sha" ] && [ "$bundle_sha" != "$(git rev-parse HEAD 2>/dev/null)" ]; then
  echo "    note: the old host was at commit ${bundle_sha:0:12}; this clone is at $(git rev-parse --short HEAD 2>/dev/null || echo '?') — fine, compose up reconciles"
fi

if [ "$FORCE" = "force" ]; then
  doomed=()
  for v in "${MIGRATE_VOLUMES[@]}"; do
    [ -f "$staging/volumes/$v.tgz" ] && volume_exists "${PROJECT}_$v" && doomed+=("${PROJECT}_$v")
  done
  echo
  echo "--force will stop the stack on THIS Mac ($(hostname)) and DELETE these volumes"
  echo "before restoring the bundle's copies: ${doomed[*]:-(none exist yet)}"
  if [ "$(manifest_get "$manifest" hostname)" = "$(hostname)" ]; then
    echo
    echo "WARNING: this bundle was made on THIS Mac. If this is the OLD host, --force"
    echo "         destroys your rollback copy — --force belongs on the NEW Mac only."
  fi
  echo
  read -r -p "Type 'force' to continue: " answer
  [ "$answer" = "force" ] || { echo "aborted; nothing changed"; exit 1; }
  echo "==> --force: removing containers and volumes from the previous attempt"
  "${COMPOSE[@]}" down --remove-orphans 2>/dev/null || true
  for v in "${doomed[@]}"; do docker volume rm -f "$v" >/dev/null; done
fi

STAGE="files"
echo "==> Restoring host files (.env, secrets, tunnel config)"
import_files "$staging" "$REPO_DIR"

echo "==> Logging the docker CLI in to GHCR (the app images are private)"
creds="$(ghcr_creds_from_authfile "$staging/secrets/ghcr-auth.json")"
read -r ghcr_user ghcr_token <<<"$creds"
printf '%s' "$ghcr_token" | docker login ghcr.io -u "$ghcr_user" --password-stdin >/dev/null 2>&1 \
  || die "GHCR login failed as $ghcr_user (expired PAT?). Create a new PAT with read:packages, put it in secrets/ghcr-auth.json on the old Mac (see DEPLOY.md → One-time setup), re-export, and re-run."
echo "    logged in as $ghcr_user"

echo "==> Pulling images (first run on this Mac — this takes a few minutes)"
"${COMPOSE[@]}" pull || die "image pull failed — see above. Fix it and re-run."

STAGE="volumes"
echo "==> Restoring volumes"
for v in "${MIGRATE_VOLUMES[@]}"; do
  if [ -f "$staging/volumes/$v.tgz" ]; then
    printf '    %-14s ' "$v"
    volume_restore "$PROJECT" "$v" "$staging/volumes/$v.tgz"
    echo "ok"
  else
    echo "    $v: not in bundle — starts empty (regenerated on first run)"
  fi
done

STAGE="up"
echo "==> Starting the stack"
"${COMPOSE[@]}" up -d --remove-orphans

if [ "$(uname)" = "Darwin" ]; then
  echo "==> Installing the auto-deploy agent"
  ./scripts/install-autodeploy.sh
else
  echo "==> Not macOS: skipping the launchd auto-deploy agent (run scripts/auto-deploy.sh from cron/systemd)"
fi

base_domain="$(env_get .env BASE_DOMAIN)"
hub_url="https://hub.${base_domain:-grmc.app}/"
wait_secs="${GRMC_MIGRATE_WAIT:-120}"
echo "==> Waiting up to ${wait_secs}s for the tunnel to serve $hub_url"
if wait_for_url "$hub_url" "$wait_secs"; then
  echo "    up: $hub_url answers through the Cloudflare Tunnel"
else
  echo "    not answering after ${wait_secs}s. Check:  $COMPOSE_CMD logs --tail 30 cloudflared traefik hub" >&2
fi

cat <<NEXT

Import finished on $(hostname). Now:

  1. From a phone OFF Wi-Fi: open $hub_url, sign in with Google, then open an app
     (whoami / minutes) — that confirms tunnel, TLS, OIDC and the restored data.
  2. Make this Mac a proper always-on host (System Settings):
       - Users & Groups → automatic login for this user (Docker Desktop and the
         auto-deploy agent run in the user session)
       - Docker Desktop → Settings → General → "Start Docker Desktop when you sign in"
       - Docker Desktop → Settings → Resources → give it the cores/memory the old
         Mac had (WHISPER_THREADS in .env assumes them)
       - Energy → prevent sleep / wake for network access
  3. Back on the OLD Mac:  ./scripts/migrate-export.sh --purge
  4. Delete the bundle (and its .sha256) from this Mac — it contains secrets and all app data.
NEXT
