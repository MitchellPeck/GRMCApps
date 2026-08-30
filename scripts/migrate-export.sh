#!/usr/bin/env bash
# Move the always-on stack OFF this Mac.
#
# Run on the OLD always-on Mac, from this repo, with Docker Desktop running:
#
#   ./scripts/migrate-export.sh [--out FILE]   # step 1: stop the stack, write one bundle
#   ./scripts/migrate-export.sh --purge        # step 3: later, wipe this host (asks first)
#
# Step 2 is scripts/migrate-import.sh <bundle> on the NEW Mac. Until you run
# --purge, everything stays on this Mac (containers stopped, volumes intact),
# so you can `docker compose -f docker-compose.yml -f docker-compose.remote.yml
# start` to roll back. Full runbook: DEPLOY.md → "Moving the stack to a new Mac".
#
# The bundle holds secrets (.env, the GHCR PAT, the tunnel credentials) and
# every app's data. Keep it private and delete it once the new host is verified.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/migrate-lib.sh
source "$REPO_DIR/scripts/lib/migrate-lib.sh"

# Same PATH fix as auto-deploy.sh: find git + docker whether Docker Desktop or
# Homebrew put them in place.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
# No AppleDouble ._* sidecars in the bundle.
export COPYFILE_DISABLE=1

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.remote.yml)

usage() {
  cat <<USAGE
Usage: $0 [--out FILE]      stop the stack and write a migration bundle
       $0 --purge           delete the stack, its data and secrets from this Mac
USAGE
}

die() { err "$@"; exit 1; }

OUT=""
MODE="export"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a file path"; OUT="$2"; shift 2 ;;
    --purge) MODE="purge"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

cd "$REPO_DIR"
PROJECT="$(compose_project_name "$REPO_DIR")"
docker info >/dev/null 2>&1 || die "Docker is not running on this Mac"

# ---------------------------------------------------------------------------
purge() {
  echo "This permanently deletes from THIS Mac ($(hostname)):"
  echo "  - every GRMCApps container and image"
  echo "  - the ${PROJECT}_pgdata / minutesdata / letsencrypt / whisperdata volumes (ALL app data)"
  echo "  - .env and secrets/ (tunnel credentials, GHCR token)"
  echo "  - the auto-deploy launchd agent"
  if [ -n "$("${COMPOSE[@]}" ps -q 2>/dev/null)" ] && "${COMPOSE[@]}" ps --status running -q 2>/dev/null | grep -q .; then
    echo
    echo "WARNING: the stack is still RUNNING here. Run the export first, and only"
    echo "purge after https://hub.grmc.app has been verified from the NEW Mac."
  fi
  echo
  read -r -p "Type 'purge' to continue: " answer
  [ "$answer" = "purge" ] || { echo "aborted; nothing changed"; exit 1; }

  echo "==> Removing the auto-deploy agent"
  ./scripts/install-autodeploy.sh --uninstall
  echo "==> Removing containers, images and volumes"
  "${COMPOSE[@]}" down -v --rmi all --remove-orphans
  echo "==> Removing host files"
  rm -f .env secrets/ghcr-auth.json secrets/cloudflared-creds.json auto-deploy.log auto-deploy.launchd.log
  git checkout -- cloudflared/config.yml 2>/dev/null || true   # back to the <TUNNEL_UUID> placeholder
  echo
  echo "Done. This Mac no longer runs GRMCApps. You can delete $REPO_DIR and, if"
  echo "nothing else needs it, uninstall Docker Desktop."
}

# ---------------------------------------------------------------------------
export_bundle() {
  local stamp staging tmp v archived=() dump_ok
  stamp="$(date +%Y%m%d-%H%M%S)"
  OUT="${OUT:-$HOME/grmc-migration-$stamp.tar}"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/grmc-migration.XXXXXX")"
  staging="$tmp/grmc-migration-$stamp"
  mkdir -p "$staging/volumes"
  # shellcheck disable=SC2064  # expand $tmp now: it is fixed for the run
  trap "rm -rf '$tmp'" EXIT

  echo "==> Collecting host files (.env, secrets, tunnel config)"
  export_files "$REPO_DIR" "$staging"   # aborts here if this is not the always-on Mac
  volume_exists "${PROJECT}_pgdata" || die "no ${PROJECT}_pgdata volume on this Mac — nothing to migrate"

  echo "==> Stopping the auto-deploy agent"
  ./scripts/install-autodeploy.sh --uninstall

  echo "==> Taking a pg_dumpall (fallback copy of the databases)"
  dump_ok=0
  # shellcheck disable=SC2016  # $POSTGRES_USER expands inside the container
  if "${COMPOSE[@]}" exec -T postgres sh -c 'pg_dumpall -U "$POSTGRES_USER"' 2>/dev/null \
      | gzip >"$staging/pg_dumpall.sql.gz"; then
    dump_ok=1
  else
    rm -f "$staging/pg_dumpall.sql.gz"
    echo "    postgres is not running; skipping the SQL dump (the pgdata volume is still copied)"
  fi

  echo "==> Stopping the stack — downtime starts now"
  "${COMPOSE[@]}" stop --timeout 60

  echo "==> Archiving volumes"
  for v in "${MIGRATE_VOLUMES[@]}"; do
    if volume_exists "${PROJECT}_$v"; then
      printf '    %-14s ' "$v"
      volume_backup "${PROJECT}_$v" "$staging/volumes/$v.tgz"
      du -h "$staging/volumes/$v.tgz" | cut -f1
      archived+=("$v")
    else
      echo "    $v: not present, skipped"
    fi
  done

  write_manifest "$staging" \
    "format=1" \
    "created_at=$(date -u +%FT%TZ)" \
    "hostname=$(hostname)" \
    "project=$PROJECT" \
    "git_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
    "volumes=${archived[*]}" \
    "pg_dumpall=$dump_ok"

  echo "==> Writing $OUT"
  mkdir -p "$(dirname "$OUT")"
  tar -cf "$OUT" -C "$tmp" "$(basename "$staging")"
  chmod 600 "$OUT"
  echo "    size    $(du -h "$OUT" | cut -f1)"
  echo "    sha256  $(shasum -a 256 "$OUT" | cut -d' ' -f1)"

  cat <<NEXT

The stack is STOPPED on this Mac (not deleted). Next:

  1. Copy the bundle to the new Mac (scp, AirDrop, a USB drive — any way you like).
  2. On the new Mac, in a fresh clone of this repo:
       ./scripts/migrate-import.sh ~/$(basename "$OUT")
  3. Verify https://hub.grmc.app from a phone off Wi-Fi, then come back here and run:
       ./scripts/migrate-export.sh --purge

To roll back instead:  docker compose -f docker-compose.yml -f docker-compose.remote.yml start
                       ./scripts/install-autodeploy.sh
NEXT
}

case "$MODE" in
  purge) purge ;;
  export) export_bundle ;;
esac
