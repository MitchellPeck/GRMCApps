#!/usr/bin/env bash
# Helpers shared by scripts/migrate-export.sh and scripts/migrate-import.sh —
# moving the always-on stack from one Mac to another. This file is SOURCED, not
# run. Everything here is a small, testable function (see
# scripts/test/migrate-lib.test.sh); the two scripts do the docker compose /
# launchctl orchestration around them.
#
# Failure convention: functions print "ERROR: ..." to stderr and return 1
# (`err` only prints — every call site pairs it with an explicit `return 1`,
# because a helper cannot return on its caller's behalf, and `set -e` is
# suspended inside `if`/`||` contexts anyway).

# Named volumes declared in docker-compose.yml (short names; the real volume is
# <project>_<name>). pgdata + minutesdata are the irreplaceable data;
# letsencrypt + whisperdata are regenerable but cheap to carry.
# shellcheck disable=SC2034  # consumed by the scripts that source this file
MIGRATE_VOLUMES=(pgdata minutesdata letsencrypt whisperdata)

# Host-only files (gitignored, or — for cloudflared/config.yml — git-tracked but
# locally edited to hold the real tunnel UUID). Paths relative to the repo root.
MIGRATE_FILES=(.env secrets/ghcr-auth.json secrets/cloudflared-creds.json cloudflared/config.yml)

# Throwaway container used to tar/untar volumes. Tiny, and its busybox tar
# supports --numeric-owner (needed so pgdata's uid 999 files survive as-is).
MIGRATE_HELPER_IMAGE="${MIGRATE_HELPER_IMAGE:-alpine:3}"

err() { echo "ERROR: $*" >&2; }

# What `docker compose` would use as the project name for <dir> (default: cwd):
# COMPOSE_PROJECT_NAME if set, else the directory name normalised the way
# Compose does it (lowercase, keep only [a-z0-9_-], strip leading _ or -).
# Traefik hardcodes the network `grmcapps_hubnet`, so this must come out as
# `grmcapps` on the host.
compose_project_name() { # [dir]
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s\n' "$COMPOSE_PROJECT_NAME"
    return 0
  fi
  local name
  name="$(basename "${1:-$PWD}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-' | sed 's/^[_-]*//')"
  printf '%s\n' "$name"
}

# Print "<user> <token>" from a Docker-config-style auth file
# ({"auths":{"ghcr.io":{"auth":"<base64 user:token>"}}}) — the same file
# Watchtower uses, so the host CLI can `docker login ghcr.io` with it too.
ghcr_creds_from_authfile() { # <ghcr-auth.json>
  local file="$1" b64 decoded
  [ -f "$file" ] || { err "no such file: $file"; return 1; }
  b64="$(tr -d ' \n\r\t' <"$file" | grep -o '"ghcr\.io":{"auth":"[^"]*"' | sed 's/.*"auth":"//; s/"$//')"
  [ -n "$b64" ] || { err "no ghcr.io auth entry in $file"; return 1; }
  decoded="$(printf '%s' "$b64" | base64 -d 2>/dev/null || printf '%s' "$b64" | base64 -D 2>/dev/null)" \
    || { err "ghcr.io auth in $file is not base64"; return 1; }
  [[ "$decoded" == *:* ]] || { err "ghcr.io auth in $file is not user:token"; return 1; }
  printf '%s %s\n' "${decoded%%:*}" "${decoded#*:}"
}

# Where a host file lives inside the bundle (dotfiles are un-hidden so they are
# obvious when someone lists the bundle).
_staging_path() { # <repo-relative file>
  case "$1" in
    .env) printf 'env\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# Copy every MIGRATE_FILES entry from <repo> into <staging>. All four must be
# present — on the always-on Mac they are, and a bundle missing any of them
# would produce a broken host.
export_files() { # <repo> <staging>
  local repo="$1" staging="$2" f dest missing=()
  for f in "${MIGRATE_FILES[@]}"; do
    [ -f "$repo/$f" ] || missing+=("$f")
  done
  [ ${#missing[@]} -eq 0 ] || { err "missing on this host (is this the always-on Mac's repo?): ${missing[*]}"; return 1; }
  for f in "${MIGRATE_FILES[@]}"; do
    dest="$staging/$(_staging_path "$f")"
    mkdir -p "$(dirname "$dest")"
    cp "$repo/$f" "$dest"
  done
}

# Inverse of export_files: put the bundled files back into a fresh clone.
# Secrets and .env are made owner-only readable.
import_files() { # <staging> <repo>
  local staging="$1" repo="$2" f src
  for f in "${MIGRATE_FILES[@]}"; do
    src="$staging/$(_staging_path "$f")"
    [ -f "$src" ] || { err "bundle is missing $f"; return 1; }
  done
  for f in "${MIGRATE_FILES[@]}"; do
    src="$staging/$(_staging_path "$f")"
    mkdir -p "$repo/$(dirname "$f")"
    cp "$src" "$repo/$f"
    case "$f" in
      .env|secrets/*) chmod 600 "$repo/$f" ;;
    esac
  done
}

write_manifest() { # <staging> key=value...
  local dir="$1"; shift
  printf '%s\n' "$@" >"$dir/MANIFEST"
}

manifest_get() { # <MANIFEST> <key>   (empty if missing)
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | head -1
}

volume_exists() { # <volume>
  docker volume inspect "$1" >/dev/null 2>&1
}

# Refuse to import over an existing install: any host-only file already in
# place (the git-tracked tunnel config only counts once its placeholder has
# been replaced) or any <project>_* volume. `force` downgrades these to
# warnings — for a deliberate re-import over a previous attempt.
import_preflight() { # <repo> <project> [force]
  local repo="$1" project="$2" force="${3:-}" f conflicts=() vols
  for f in "${MIGRATE_FILES[@]}"; do
    [ -f "$repo/$f" ] || continue
    if [ "$f" = "cloudflared/config.yml" ] && grep -q '<TUNNEL_UUID>' "$repo/$f"; then
      continue
    fi
    conflicts+=("file $f")
  done
  if docker info >/dev/null 2>&1; then
    vols="$(docker volume ls -q --filter "name=^${project}_" 2>/dev/null || true)"
    for f in $vols; do conflicts+=("volume $f"); done
  fi
  [ ${#conflicts[@]} -eq 0 ] && return 0
  if [ "$force" = "force" ]; then
    echo "WARNING: overwriting existing state (--force): ${conflicts[*]}" >&2
    return 0
  fi
  err "this host already has GRMCApps state: ${conflicts[*]} — re-run with --force to overwrite it"
  return 1
}

# Tar a named volume to <out.tgz> via a throwaway container. Owners are stored
# numerically so a Postgres data dir (uid 999) restores byte-for-byte.
volume_backup() { # <volume> <out.tgz>
  local vol="$1" out="$2" outdir outname
  volume_exists "$vol" || { err "volume $vol does not exist"; return 1; }
  mkdir -p "$(dirname "$out")"
  outdir="$(cd "$(dirname "$out")" && pwd)"
  outname="$(basename "$out")"
  docker run --rm -v "$vol:/v:ro" -v "$outdir:/out" "$MIGRATE_HELPER_IMAGE" \
    tar --numeric-owner -czf "/out/$outname" -C /v .
}

# Untar <in.tgz> into <project>_<name>, creating the volume with the labels
# Compose expects so `docker compose up` adopts it silently (an unlabeled volume
# of the right name still works, but Compose warns it "was not created by
# Docker Compose").
volume_restore() { # <project> <name> <in.tgz>
  local project="$1" name="$2" in="$3" vol indir inname
  vol="${project}_${name}"
  [ -f "$in" ] || { err "no such tarball: $in"; return 1; }
  indir="$(cd "$(dirname "$in")" && pwd)"
  inname="$(basename "$in")"
  if ! volume_exists "$vol"; then
    docker volume create \
      --label "com.docker.compose.project=$project" \
      --label "com.docker.compose.volume=$name" \
      "$vol" >/dev/null
  fi
  docker run --rm -v "$vol:/v" -v "$indir:/in:ro" "$MIGRATE_HELPER_IMAGE" \
    tar --numeric-owner -xzf "/in/$inname" -C /v
}

# Poll <url> until it answers with any HTTP status below 500 (a 302 to Google
# sign-in counts; Cloudflare's 530 "origin unreachable" does not). Returns 1
# once <timeout> seconds have passed.
wait_for_url() { # <url> <timeout-seconds>
  local url="$1" timeout="$2" start code
  start="$(date +%s)"
  while :; do
    code="$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null)" || code="000"
    if [[ "$code" =~ ^[0-9]{3}$ ]] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then return 0; fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then return 1; fi
    sleep 3
  done
}
