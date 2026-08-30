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
# so you can roll back with
#   docker compose -f docker-compose.yml -f docker-compose.remote.yml start
#   ./scripts/install-autodeploy.sh
# Full runbook: DEPLOY.md → "Moving the stack to a new Mac".
#
# The bundle holds secrets (.env, the GHCR PAT, the tunnel credentials) and
# every app's data. Keep it private; --purge deletes any left in $HOME. A
# <bundle>.sha256 sidecar is written next to it — copy both, and the import
# verifies the bundle survived the transfer.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/migrate-lib.sh
source "$REPO_DIR/scripts/lib/migrate-lib.sh"

# Fallback locations for git + docker if the shell's PATH is minimal (appended,
# so whatever the caller has first still wins).
export PATH="${PATH:-}:/opt/homebrew/bin:/usr/local/bin"
# No AppleDouble ._* sidecars in the bundle.
export COPYFILE_DISABLE=1

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.remote.yml)
COMPOSE_CMD="docker compose -f docker-compose.yml -f docker-compose.remote.yml"

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

stack_running() {
  "${COMPOSE[@]}" ps --status running -q 2>/dev/null | grep -q .
}

# ---------------------------------------------------------------------------
purge() {
  local base_domain b bundles=()
  base_domain="$(env_get .env BASE_DOMAIN)"
  base_domain="${base_domain:-grmc.app}"
  for b in "$HOME"/grmc-migration-*.tar; do [ -e "$b" ] && bundles+=("$b"); done

  echo "This permanently deletes from THIS Mac ($(hostname)):"
  echo "  - every GRMCApps container and image"
  echo "  - every ${PROJECT}_* volume — pgdata, minutesdata, letsencrypt, whisperdata (ALL app data)"
  echo "  - .env and secrets/ (tunnel credentials, GHCR token), and the docker CLI's GHCR login"
  echo "  - the auto-deploy launchd agent"
  for b in "${bundles[@]}"; do echo "  - the migration bundle $b"; done
  echo
  if stack_running; then
    echo "WARNING: the stack is still RUNNING here. Run the export first; purge only"
    echo "         after https://hub.$base_domain has been verified from the NEW Mac."
    echo
  fi
  echo "Checking whether anything is serving https://hub.$base_domain/ ..."
  if wait_for_url "https://hub.$base_domain/" 15; then
    echo "    it answers — the new Mac is serving it (assuming the stack here is stopped)."
  else
    echo "WARNING: nobody is serving https://hub.$base_domain/ right now. If the new Mac is"
    echo "         not up yet, purging deletes the LAST copy of the data. To roll back instead:"
    echo "           $COMPOSE_CMD start && ./scripts/install-autodeploy.sh"
  fi
  echo
  read -r -p "Type 'purge' to continue: " answer
  [ "$answer" = "purge" ] || { echo "aborted; nothing changed"; exit 1; }

  echo "==> Removing the auto-deploy agent"
  ./scripts/install-autodeploy.sh --uninstall
  echo "==> Removing containers, images and volumes"
  "${COMPOSE[@]}" down -v --rmi all --remove-orphans || echo "    warning: compose down failed (already purged?) — continuing"
  # `down -v` only knows the volumes the current compose file declares; sweep
  # anything else this project ever created (older stack versions, renames).
  docker volume ls -q --filter "name=^${PROJECT}_" | xargs -r docker volume rm >/dev/null 2>&1 || true
  echo "==> Removing host files"
  rm -f .env secrets/ghcr-auth.json secrets/cloudflared-creds.json auto-deploy.log auto-deploy.launchd.log
  git checkout -- cloudflared/config.yml 2>/dev/null || true   # back to the <TUNNEL_UUID> placeholder
  for b in "${bundles[@]}"; do rm -f "$b" "$b.sha256"; echo "    removed $b"; done
  docker logout ghcr.io >/dev/null 2>&1 || true
  echo
  echo "Done. This Mac no longer runs GRMCApps. You can delete $REPO_DIR and, if"
  echo "nothing else needs it, uninstall Docker Desktop. If you wrote a bundle"
  echo "somewhere other than \$HOME (--out), delete it by hand."
}

# ---------------------------------------------------------------------------
STOPPED=0
TMP=""
on_exit() {
  local rc=$?
  [ -n "$TMP" ] && rm -rf "$TMP"
  if [ "$rc" -ne 0 ] && [ "$STOPPED" -eq 1 ]; then
    cat >&2 <<ROLLBACK

Export FAILED after the stack was stopped. Nothing was deleted. To bring this
Mac back up while you sort out the error above:
  $COMPOSE_CMD start
  ./scripts/install-autodeploy.sh
Then re-run the export.
ROLLBACK
  fi
  exit "$rc"
}

export_bundle() {
  local stamp staging v archived=() dump_ok dump_err sha
  stamp="$(date +%Y%m%d-%H%M%S)"
  OUT="${OUT:-$HOME/grmc-migration-$stamp.tar}"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/grmc-migration.XXXXXX")"
  trap on_exit EXIT
  staging="$TMP/grmc-migration-$stamp"
  mkdir -p "$staging/volumes"

  echo "==> Checking this is the always-on Mac (.env, secrets, tunnel config)"
  export_files "$REPO_DIR" "$staging"   # aborts here, before anything is touched, if not
  volume_exists "${PROJECT}_pgdata" || die "no ${PROJECT}_pgdata volume on this Mac — nothing to migrate"

  echo "==> Stopping the auto-deploy agent"
  ./scripts/install-autodeploy.sh --uninstall

  echo "==> Taking a pg_dumpall (fallback copy of the databases)"
  dump_ok=0
  dump_err="$TMP/pg_dumpall.err"
  # --clean --if-exists: the dump drops and recreates each app database/role, so
  # loading it into a freshly initialised cluster (which db/init/ has already
  # seeded) replaces the seed instead of colliding with it.
  # shellcheck disable=SC2016  # $POSTGRES_USER expands inside the container
  if "${COMPOSE[@]}" exec -T postgres sh -c 'pg_dumpall --clean --if-exists -U "$POSTGRES_USER"' 2>"$dump_err" \
      | gzip >"$staging/pg_dumpall.sql.gz"; then
    dump_ok=1
  else
    rm -f "$staging/pg_dumpall.sql.gz"
    echo "    skipped: $(tr '\n' ' ' <"$dump_err" | cut -c1-200)"
    echo "    (the pgdata volume is still copied — this only affects the fallback)"
  fi

  echo "==> Stopping the stack — downtime starts now"
  STOPPED=1
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
    "arch=$(uname -m)" \
    "project=$PROJECT" \
    "git_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
    "volumes=${archived[*]}" \
    "pg_dumpall=$dump_ok"

  echo "==> Writing $OUT"
  mkdir -p "$(dirname "$OUT")"
  tar -cf "$OUT" -C "$TMP" "$(basename "$staging")"
  chmod 600 "$OUT" 2>/dev/null || echo "    (could not chmod 600 — non-Mac filesystem? keep the bundle private)"
  sha="$(shasum -a 256 "$OUT" | cut -d' ' -f1)"
  printf '%s  %s\n' "$sha" "$(basename "$OUT")" >"$OUT.sha256"
  echo "    size    $(du -h "$OUT" | cut -f1)"
  echo "    sha256  $sha  (also in $(basename "$OUT").sha256)"

  cat <<NEXT

The stack is STOPPED on this Mac (not deleted). Next:

  1. Copy the bundle AND its .sha256 file to the new Mac (scp, AirDrop, a USB
     drive — any way you like; FAT32 sticks cannot hold files over 4 GB).
  2. On the new Mac, in a fresh clone of this repo:
       ./scripts/migrate-import.sh ~/$(basename "$OUT")
  3. Verify https://hub.$(env_get .env BASE_DOMAIN) from a phone off Wi-Fi, then come back here and run:
       ./scripts/migrate-export.sh --purge

To roll back instead:  $COMPOSE_CMD start
                       ./scripts/install-autodeploy.sh
NEXT
}

case "$MODE" in
  purge) purge ;;
  export) export_bundle ;;
esac
