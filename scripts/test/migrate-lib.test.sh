#!/usr/bin/env bash
# Tests for scripts/lib/migrate-lib.sh (the host-migration helpers).
#
#   ./scripts/test/migrate-lib.test.sh
#
# Needs Docker running for the volume round-trip tests. Only volumes named
# grmcmigtest_* are created and they are removed on exit; the real grmcapps_*
# volumes are never touched. No test framework: plain bash + asserts.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/migrate-lib.sh
source "$HERE/../lib/migrate-lib.sh" || { echo "FATAL: cannot source migrate-lib.sh"; exit 1; }

TEST_PROJECT="grmcmigtest"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/migrate-test.XXXXXX")"
PASS=0; FAIL=0
cleanup() {
  rm -rf "$TMP"
  docker volume ls -q --filter "name=^${TEST_PROJECT}_" 2>/dev/null | xargs -r docker volume rm >/dev/null 2>&1 || true
  [ -n "${HTTP_PID:-}" ] && kill "$HTTP_PID" 2>/dev/null || true
}
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ $# -gt 1 ] && echo "       $2"; }
assert_eq() { # <name> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi
}
assert_ok() { # <name> <cmd...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name" "expected success"; fi
}
assert_fails() { # <name> <cmd...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then fail "$name" "expected failure"; else pass "$name"; fi
}

# Build a fake repo dir with the four host-only files present.
make_repo() { # <dir>
  mkdir -p "$1/secrets" "$1/cloudflared"
  printf 'BASE_DOMAIN=grmc.app\nPOSTGRES_USER=postgres\n' >"$1/.env"
  printf '{"auths":{"ghcr.io":{"auth":"x"}}}\n' >"$1/secrets/ghcr-auth.json"
  printf '{"AccountTag":"a","TunnelID":"b"}\n' >"$1/secrets/cloudflared-creds.json"
  printf 'tunnel: 1111-2222\ningress:\n  - service: https://traefik:443\n' >"$1/cloudflared/config.yml"
}

echo "compose_project_name"
assert_eq "env override wins" "custom" "$(COMPOSE_PROJECT_NAME=custom compose_project_name /x/GRMCApps)"
assert_eq "lowercases the dir basename" "grmcapps" "$( (unset COMPOSE_PROJECT_NAME; compose_project_name /x/GRMCApps) )"
assert_eq "drops chars compose drops" "grmcapps2" "$( (unset COMPOSE_PROJECT_NAME; compose_project_name "/x/ -GRMC Apps.2") )"

echo "ghcr_creds_from_authfile"
auth="$(printf 'MitchellPeck:ghp_secret123' | base64)"
printf '{\n  "auths": { "ghcr.io": { "auth": "%s" } }\n}\n' "$auth" >"$TMP/ghcr-auth.json"
assert_eq "prints user and token" "MitchellPeck ghp_secret123" "$(ghcr_creds_from_authfile "$TMP/ghcr-auth.json")"
printf '{"auths":{"docker.io":{"auth":"%s"}}}\n' "$auth" >"$TMP/other-auth.json"
assert_fails "fails without a ghcr.io entry" ghcr_creds_from_authfile "$TMP/other-auth.json"
assert_fails "fails on a missing file" ghcr_creds_from_authfile "$TMP/nope.json"

echo "export_files"
make_repo "$TMP/repo"
mkdir -p "$TMP/staging"
assert_ok "copies the host-only files" export_files "$TMP/repo" "$TMP/staging"
assert_eq ".env lands as env" "BASE_DOMAIN=grmc.app" "$(head -1 "$TMP/staging/env")"
assert_ok "ghcr auth copied" test -f "$TMP/staging/secrets/ghcr-auth.json"
assert_ok "tunnel creds copied" test -f "$TMP/staging/secrets/cloudflared-creds.json"
assert_eq "tunnel config copied with its UUID" "tunnel: 1111-2222" "$(head -1 "$TMP/staging/cloudflared/config.yml")"
make_repo "$TMP/repo-missing"; rm "$TMP/repo-missing/secrets/cloudflared-creds.json"
mkdir -p "$TMP/staging2"
assert_fails "fails when a required file is missing" export_files "$TMP/repo-missing" "$TMP/staging2"

make_repo "$TMP/repo-placeholder"; printf 'tunnel: <TUNNEL_UUID>\n' >"$TMP/repo-placeholder/cloudflared/config.yml"
mkdir -p "$TMP/staging3"
assert_fails "fails when the tunnel config still has the git placeholder" export_files "$TMP/repo-placeholder" "$TMP/staging3"

echo "env_get"
printf 'A=plain\nB="quoted"\nC=%s\n' "'single'" >"$TMP/dotenv"
assert_eq "plain value" "plain" "$(env_get "$TMP/dotenv" A)"
assert_eq "strips double quotes" "quoted" "$(env_get "$TMP/dotenv" B)"
assert_eq "strips single quotes" "single" "$(env_get "$TMP/dotenv" C)"
assert_eq "empty for a missing key" "" "$(env_get "$TMP/dotenv" Z)"
assert_eq "empty for a missing file" "" "$(env_get "$TMP/nofile" A)"

echo "import_files"
mkdir -p "$TMP/newrepo/cloudflared"
printf 'tunnel: <TUNNEL_UUID>\n' >"$TMP/newrepo/cloudflared/config.yml"   # fresh clone placeholder
assert_ok "restores the host-only files" import_files "$TMP/staging" "$TMP/newrepo"
assert_eq "env restored as .env" "BASE_DOMAIN=grmc.app" "$(head -1 "$TMP/newrepo/.env")"
assert_eq ".env is 600" "600" "$(stat -f '%Lp' "$TMP/newrepo/.env")"
assert_eq "secrets are 600" "600" "$(stat -f '%Lp' "$TMP/newrepo/secrets/cloudflared-creds.json")"
assert_eq "tunnel config overwrites the placeholder" "tunnel: 1111-2222" "$(head -1 "$TMP/newrepo/cloudflared/config.yml")"

echo "manifest"
write_manifest "$TMP/staging" "format=1" "git_sha=abc123" "hostname=old-mac"
assert_eq "manifest_get reads a key" "abc123" "$(manifest_get "$TMP/staging/MANIFEST" git_sha)"
assert_eq "manifest_get is empty for a missing key" "" "$(manifest_get "$TMP/staging/MANIFEST" nope)"

echo "import_preflight (files)"
mkdir -p "$TMP/clean"
assert_ok "passes on a clean checkout" import_preflight "$TMP/clean" "${TEST_PROJECT}pf"
touch "$TMP/clean/.env"
assert_fails "fails when .env already exists" import_preflight "$TMP/clean" "${TEST_PROJECT}pf"
assert_ok "--force overrides existing files" import_preflight "$TMP/clean" "${TEST_PROJECT}pf" force
mkdir -p "$TMP/fresh-clone/cloudflared"
printf 'tunnel: <TUNNEL_UUID>\n' >"$TMP/fresh-clone/cloudflared/config.yml"
assert_ok "ignores the git-tracked tunnel config while it still has the placeholder" import_preflight "$TMP/fresh-clone" "${TEST_PROJECT}pf"
printf 'tunnel: 1111-2222\n' >"$TMP/fresh-clone/cloudflared/config.yml"
assert_fails "fails when the tunnel config already has a real UUID" import_preflight "$TMP/fresh-clone" "${TEST_PROJECT}pf"

echo "wait_for_url"
PORT=18765
( cd "$TMP" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
HTTP_PID=$!
assert_ok "returns 0 once the URL answers" wait_for_url "http://127.0.0.1:$PORT/" 10
assert_fails "returns 1 after the timeout" wait_for_url "http://127.0.0.1:18766/" 2

if docker info >/dev/null 2>&1; then
  echo "volume_exists"
  docker volume create "${TEST_PROJECT}_src" >/dev/null
  assert_ok "true for an existing volume" volume_exists "${TEST_PROJECT}_src"
  assert_fails "false for a missing volume" volume_exists "${TEST_PROJECT}_nope"

  echo "import_preflight (volumes)"
  mkdir -p "$TMP/clean2"
  assert_fails "fails when a project volume exists" import_preflight "$TMP/clean2" "$TEST_PROJECT"
  assert_ok "--force overrides existing volumes" import_preflight "$TMP/clean2" "$TEST_PROJECT" force

  echo "volume round-trip"
  # Seed: nested dir, a root-owned 600 file (like acme.json), a 999:999 file (like pgdata).
  docker run --rm -v "${TEST_PROJECT}_src:/v" alpine:3 sh -c \
    'mkdir -p /v/a && printf hello >/v/a/b.txt && chmod 600 /v/a/b.txt && printf pg >/v/PG_VERSION && chown 999:999 /v/PG_VERSION' \
    >/dev/null
  assert_ok "volume_backup writes a tarball" volume_backup "${TEST_PROJECT}_src" "$TMP/src.tgz"
  assert_ok "tarball is gzip" sh -c "gzip -t '$TMP/src.tgz'"
  assert_ok "volume_restore creates the volume and restores" volume_restore "$TEST_PROJECT" dst "$TMP/src.tgz"
  assert_eq "file content survives" "hello" "$(docker run --rm -v "${TEST_PROJECT}_dst:/v" alpine:3 cat /v/a/b.txt)"
  assert_eq "mode survives" "600" "$(docker run --rm -v "${TEST_PROJECT}_dst:/v" alpine:3 stat -c %a /v/a/b.txt)"
  assert_eq "numeric owner survives" "999:999" "$(docker run --rm -v "${TEST_PROJECT}_dst:/v" alpine:3 stat -c %u:%g /v/PG_VERSION)"
  assert_eq "restored volume carries compose labels" "$TEST_PROJECT dst" \
    "$(docker volume inspect "${TEST_PROJECT}_dst" --format '{{index .Labels "com.docker.compose.project"}} {{index .Labels "com.docker.compose.volume"}}')"
  assert_fails "volume_restore refuses a missing tarball" volume_restore "$TEST_PROJECT" dst2 "$TMP/missing.tgz"
  docker volume create "${TEST_PROJECT}_pre" >/dev/null
  assert_ok "volume_restore into a volume that already exists" volume_restore "$TEST_PROJECT" pre "$TMP/src.tgz"
  assert_eq "content lands in the existing volume" "hello" "$(docker run --rm -v "${TEST_PROJECT}_pre:/v" alpine:3 cat /v/a/b.txt)"
else
  echo "SKIP: docker not reachable — volume tests not run"
  FAIL=$((FAIL + 1))
fi

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
