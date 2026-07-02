#!/usr/bin/env bash
# Host-side auto-deploy for the always-on Mac.
#
# Watchtower keeps app *images* current, but it cannot apply docker-compose
# structural changes — new services, changed images/ports/env. So when the
# compose file changes (e.g. adding the `whisper` service), the running stack
# drifts from the repo until someone runs `docker compose up -d` on the host.
# Offsite, that never happens. This script closes that gap: on a schedule
# (via launchd — see scripts/install-autodeploy.sh) it fast-forwards the deploy
# branch and, only when something actually changed, pulls images and re-applies
# the compose files. Idempotent and safe to run every few minutes.
#
# Env overrides (all optional):
#   GRMC_DEPLOY_BRANCH   branch to track            (default: main)
#   GRMC_DEPLOY_REMOTE   git remote                 (default: origin)
#   GRMC_DEPLOY_LOG      log file                   (default: <repo>/auto-deploy.log)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${GRMC_DEPLOY_BRANCH:-main}"
REMOTE="${GRMC_DEPLOY_REMOTE:-origin}"
LOG="${GRMC_DEPLOY_LOG:-$REPO_DIR/auto-deploy.log}"

# launchd runs with a minimal PATH; make sure git + docker are found. Covers
# Docker Desktop (/usr/local/bin) and Homebrew on Apple Silicon (/opt/homebrew).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

# The remote host runs both compose files (see docker-compose.remote.yml).
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.remote.yml)

# Single-run lock (mkdir is atomic; no flock needed on macOS).
LOCKDIR="${TMPDIR:-/tmp}/grmc-autodeploy.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "$(date '+%FT%T%z') another run in progress; skipping" >>"$LOG"
  exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

exec >>"$LOG" 2>&1
echo "=== $(date '+%FT%T%z') auto-deploy ==="
cd "$REPO_DIR"

git fetch --quiet "$REMOTE" "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "$REMOTE/$BRANCH")"

if [ "$LOCAL" = "$REMOTE_SHA" ]; then
  echo "up to date at ${LOCAL:0:12}; nothing to deploy"
  exit 0
fi

echo "deploying ${LOCAL:0:12} -> ${REMOTE_SHA:0:12}"
# Fast-forward only: never clobber local state; if the branches diverged, stop
# and surface it rather than force-resetting a production host.
git checkout --quiet "$BRANCH"
if ! git merge --ff-only --quiet "$REMOTE/$BRANCH"; then
  echo "ERROR: cannot fast-forward $BRANCH (local commits or divergence). Skipping." >&2
  exit 1
fi

# Pull images (app images from GHCR, third-party like whisper/postgres). Best
# effort: if the host is not logged in to GHCR, keep going — Watchtower keeps
# app images fresh and `up -d` will use what is present.
"${COMPOSE[@]}" pull --quiet || echo "warning: 'compose pull' failed; using images already present"

# Apply the compose files: creates new services, recreates changed containers,
# and removes orphans. Existing, unchanged containers are left running.
"${COMPOSE[@]}" up -d --remove-orphans

echo "deploy complete at $(git rev-parse --short HEAD)"
