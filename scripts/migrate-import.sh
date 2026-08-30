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
# It restores .env / secrets / the tunnel config, restores the Docker volumes,
# logs the docker CLI into GHCR with the PAT already in secrets/ghcr-auth.json
# (a fresh host cannot pull the private images otherwise), starts the stack
# with both compose files, installs the auto-deploy agent, and waits for the
# tunnel to answer. --force re-imports over a previous attempt on this Mac.
# GRMC_MIGRATE_WAIT (seconds, default 120) bounds the final tunnel wait.
# Full runbook: DEPLOY.md → "Moving the stack to a new Mac".
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/migrate-lib.sh
source "$REPO_DIR/scripts/lib/migrate-lib.sh"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.remote.yml)

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

import_preflight "$REPO_DIR" "$PROJECT" "$FORCE"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/grmc-migration.XXXXXX")"
# shellcheck disable=SC2064
trap "rm -rf '$tmp'" EXIT

echo "==> Unpacking $(basename "$BUNDLE")"
tar -xf "$BUNDLE" -C "$tmp"
staging="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$staging" ] && [ -f "$staging/MANIFEST" ] || die "not a migration bundle (no MANIFEST inside)"
[ -f "$staging/volumes/pgdata.tgz" ] || die "bundle has no pgdata volume — refusing to start with an empty database"
echo "    made on $(manifest_get "$staging/MANIFEST" hostname) at $(manifest_get "$staging/MANIFEST" created_at)"
bundle_sha="$(manifest_get "$staging/MANIFEST" git_sha)"
if [ -n "$bundle_sha" ] && [ "$bundle_sha" != "$(git rev-parse HEAD 2>/dev/null)" ]; then
  echo "    note: the old host was at commit ${bundle_sha:0:12}; this clone is at $(git rev-parse --short HEAD 2>/dev/null || echo '?') — fine, compose up reconciles"
fi

if [ "$FORCE" = "force" ]; then
  echo "==> --force: removing containers and volumes from the previous attempt"
  "${COMPOSE[@]}" down --remove-orphans 2>/dev/null || true
  for v in "${MIGRATE_VOLUMES[@]}"; do
    [ -f "$staging/volumes/$v.tgz" ] && volume_exists "${PROJECT}_$v" && docker volume rm -f "${PROJECT}_$v" >/dev/null
  done
fi

echo "==> Restoring host files (.env, secrets, tunnel config)"
import_files "$staging" "$REPO_DIR"

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

echo "==> Logging the docker CLI in to GHCR (private images)"
creds="$(ghcr_creds_from_authfile secrets/ghcr-auth.json)"
read -r ghcr_user ghcr_token <<<"$creds"
if printf '%s' "$ghcr_token" | docker login ghcr.io -u "$ghcr_user" --password-stdin >/dev/null 2>&1; then
  echo "    logged in as $ghcr_user"
else
  echo "    WARNING: login failed (expired PAT?). Run: docker login ghcr.io -u $ghcr_user" >&2
fi

echo "==> Starting the stack (pulls images on first run — this can take a few minutes)"
"${COMPOSE[@]}" up -d --remove-orphans

if [ "$(uname)" = "Darwin" ]; then
  echo "==> Installing the auto-deploy agent"
  ./scripts/install-autodeploy.sh
else
  echo "==> Not macOS: skipping the launchd auto-deploy agent (run scripts/auto-deploy.sh from cron/systemd)"
fi

base_domain="$(sed -n 's/^BASE_DOMAIN=//p' .env | head -1)"
hub_url="https://hub.${base_domain:-grmc.app}/"
echo "==> Waiting for the tunnel to serve $hub_url"
wait_secs="${GRMC_MIGRATE_WAIT:-120}"
if wait_for_url "$hub_url" "$wait_secs"; then
  echo "    up: $hub_url answers through the Cloudflare Tunnel"
else
  echo "    not answering after ${wait_secs}s. Check:  ${COMPOSE[*]} logs --tail 30 cloudflared traefik hub" >&2
fi

cat <<NEXT

Import finished on $(hostname). Now:

  1. From a phone OFF Wi-Fi: open $hub_url, sign in with Google, then open an app
     (whoami / minutes) — confirms tunnel, TLS, OIDC and the restored data.
  2. Make this Mac a proper always-on host (System Settings):
       - Users & Groups → automatic login for this user (Docker Desktop and the
         auto-deploy agent run in the user session)
       - Docker Desktop → Settings → General → "Start Docker Desktop when you sign in"
       - Energy → prevent sleep / wake for network access
  3. Back on the OLD Mac:  ./scripts/migrate-export.sh --purge
  4. Delete the bundle file — it contains secrets and all app data.
NEXT
