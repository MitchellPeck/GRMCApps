#!/usr/bin/env bash
# End-to-end test of scripts/migrate-export.sh and scripts/migrate-import.sh.
#
#   ./scripts/test/migrate-e2e.test.sh
#
# Runs the REAL scripts against scratch clones of this repo, isolated from the
# machine it runs on:
#   - scratch clones (working tree, incl. uncommitted changes) under a temp dir
#   - HOME is pointed at a scratch dir (so launchd/bundle globs never see yours)
#   - `docker login` / `docker logout` are shimmed (your GHCR login is untouched)
#   - the import clone gets a stub docker-compose.yml (one alpine container) so
#     `pull`/`up`/`down --rmi all` never touch real images or ports
#   - only grmcmigexp_* / grmcmigimp_* volumes are created, and removed on exit
# Needs Docker running and network access (pulls alpine:3).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REAL_DOCKER="$(command -v docker)" || { echo "FATAL: docker not found"; exit 1; }
docker info >/dev/null 2>&1 || { echo "FATAL: docker is not running"; exit 1; }
# Keep talking to the same daemon after HOME changes (Docker Desktop's socket
# lives under the real HOME).
DOCKER_HOST_REAL="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
[ -n "$DOCKER_HOST_REAL" ] && export DOCKER_HOST="$DOCKER_HOST_REAL"

S="$(mktemp -d "${TMPDIR:-/tmp}/grmc-e2e.XXXXXX")"
PASS=0; FAIL=0
cleanup() {
  ( cd "$S/grmcmigimp" 2>/dev/null && docker compose -f docker-compose.yml -f docker-compose.remote.yml down -v >/dev/null 2>&1 ) || true
  docker volume ls -q --filter 'name=^grmcmig' 2>/dev/null | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  rm -rf "$S"
}
trap cleanup EXIT
pass() { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ $# -gt 1 ] && echo "       $2"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi; }
assert_ok() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$n"; else fail "$n"; fi; }
assert_fails() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$n" "expected failure"; else pass "$n"; fi; }

# --- isolation -------------------------------------------------------------
mkdir -p "$S/bin" "$S/home/.docker"
SHIM_LOG="$S/shim.log"; : >"$SHIM_LOG"
cat >"$S/bin/docker" <<SHIM
#!/usr/bin/env bash
# e2e shim: swallow login/logout (logging them), forward everything else.
case "\${1:-}" in login|logout) echo "docker \$*" >>"$SHIM_LOG"; exit 0 ;; esac
exec "$REAL_DOCKER" "\$@"
SHIM
chmod +x "$S/bin/docker"
# The compose plugin is discovered under \$HOME/.docker/cli-plugins — keep it
# reachable from the scratch HOME (credentials are NOT carried over: the shim
# swallows login/logout and nothing else here needs auth).
[ -d "${HOME}/.docker/cli-plugins" ] && ln -s "${HOME}/.docker/cli-plugins" "$S/home/.docker/cli-plugins"
export PATH="$S/bin:$PATH"
export HOME="$S/home"
export COMPOSE_PROJECT_NAME=   # make sure the dir name decides
unset COMPOSE_PROJECT_NAME

clone() { # <dir>: a clone of HEAD plus the working tree's modified/untracked files
  git clone -q "$REPO" "$1"
  ( cd "$REPO" && git ls-files -mo --exclude-standard -z ) | while IFS= read -r -d '' f; do
    [ -f "$REPO/$f" ] || continue
    mkdir -p "$1/$(dirname "$f")"; cp "$REPO/$f" "$1/$f"
  done
}
fake_host_files() { # <dir>
  cat >"$1/.env" <<ENV
BASE_DOMAIN=example.invalid
SESSION_SECRET=x
POSTGRES_USER=postgres
POSTGRES_PASSWORD=x
POSTGRES_DB=postgres
ACME_EMAIL=x@example.invalid
CF_DNS_API_TOKEN=x
ENV
  mkdir -p "$1/secrets"
  printf '{\n  "auths": { "ghcr.io": { "auth": "%s" } }\n}\n' "$(printf 'fakeuser:faketoken' | base64)" >"$1/secrets/ghcr-auth.json"
  printf '{"AccountTag":"fake","TunnelID":"deadbeef"}\n' >"$1/secrets/cloudflared-creds.json"
}
stub_compose() { # <dir> <project>: tiny compose files so up/pull/down touch nothing real
  cat >"$1/docker-compose.yml" <<STUB
# e2e stub — the real file carries: --providers.docker.network=${2}_hubnet
services:
  stub:
    image: alpine:3
    command: sleep 600
    networks: [hubnet]
networks:
  hubnet:
STUB
  printf 'services: {}\n' >"$1/docker-compose.remote.yml"
}
vol_cat() { docker run --rm -v "$1:/v" alpine:3 cat "/v/$2" 2>/dev/null; }

# --- export ----------------------------------------------------------------
echo "export: guard"
clone "$S/grmcmigexp"
cd "$S/grmcmigexp" || exit 1
fake_host_files .
out="$(./scripts/migrate-export.sh --out "$S/nope.tar" 2>&1)"; rc=$?
assert_eq "refuses while cloudflared/config.yml has the placeholder" "1" "$rc"
assert_ok "…and names the reason" grep -q 'TUNNEL_UUID' <<<"$out"
assert_fails "…without writing a bundle" test -e "$S/nope.tar"

echo "export: bundle"
sed -i '' 's/<TUNNEL_UUID>/deadbeef-0000-4000-8000-000000000000/' cloudflared/config.yml
docker run --rm -v grmcmigexp_pgdata:/v alpine:3 sh -c 'printf 16 >/v/PG_VERSION && mkdir /v/base && chown -R 999:999 /v' >/dev/null
docker run --rm -v grmcmigexp_minutesdata:/v alpine:3 sh -c 'mkdir -p /v/recordings && printf audio >/v/recordings/m1.webm' >/dev/null
out="$(./scripts/migrate-export.sh --out "$S/bundle.tar" 2>&1)"; rc=$?
assert_eq "export exits 0" "0" "$rc"
[ "$rc" -eq 0 ] || echo "$out"
assert_ok "bundle written" test -f "$S/bundle.tar"
assert_ok "sha256 sidecar written" test -f "$S/bundle.tar.sha256"
assert_ok "sidecar verifies" sh -c "cd '$S' && shasum -a 256 -c bundle.tar.sha256"
assert_eq "bundle mode 600" "600" "$(stat -f '%Lp' "$S/bundle.tar")"
manifest="$(tar -xOf "$S/bundle.tar" '*/MANIFEST')"
assert_eq "manifest records the volumes" "volumes=pgdata minutesdata" "$(grep '^volumes=' <<<"$manifest")"
assert_eq "manifest records the arch" "arch=$(uname -m)" "$(grep '^arch=' <<<"$manifest")"
assert_ok "pg_dumpall skipped without postgres (fallback only)" grep -q 'pg_dumpall=0' <<<"$manifest"
assert_ok "export output points at the rollback" grep -q 'To roll back' <<<"$out"

# --- import ----------------------------------------------------------------
echo "import: fresh host"
clone "$S/grmcmigimp"
cd "$S/grmcmigimp" || exit 1
stub_compose . grmcmigimp
printf '#!/usr/bin/env bash\necho "(stub) install-autodeploy $*"\n' >scripts/install-autodeploy.sh
out="$(GRMC_MIGRATE_WAIT=1 ./scripts/migrate-import.sh "$S/bundle.tar" 2>&1)"; rc=$?
assert_eq "import exits 0" "0" "$rc"
[ "$rc" -eq 0 ] || echo "$out"
assert_ok "checksum was verified" grep -q 'Verifying' <<<"$out"
assert_eq ".env restored (600)" "600 BASE_DOMAIN=example.invalid" "$(stat -f '%Lp' .env) $(head -1 .env)"
assert_eq "secrets restored (600)" "600 600" "$(stat -f '%Lp' secrets/ghcr-auth.json) $(stat -f '%Lp' secrets/cloudflared-creds.json)"
assert_eq "tunnel config carries the UUID" "tunnel: deadbeef-0000-4000-8000-000000000000" "$(grep '^tunnel:' cloudflared/config.yml)"
assert_eq "pgdata content + owner" "16 999:999" "$(vol_cat grmcmigimp_pgdata PG_VERSION) $(docker run --rm -v grmcmigimp_pgdata:/v alpine:3 stat -c %u:%g /v/PG_VERSION)"
assert_eq "minutesdata content" "audio" "$(vol_cat grmcmigimp_minutesdata recordings/m1.webm)"
assert_eq "restored volume has compose labels" "grmcmigimp/pgdata" "$(docker volume inspect grmcmigimp_pgdata --format '{{index .Labels "com.docker.compose.project"}}/{{index .Labels "com.docker.compose.volume"}}')"
assert_eq "stack is up" "running" "$(docker compose ps --format '{{.State}}' stub)"
assert_ok "login went through the shim (never the real CLI)" grep -q '^docker login ghcr.io' "$SHIM_LOG"
assert_eq "compose adopts the volumes silently" "" "$(docker compose up -d 2>&1 | grep -i 'not created by' || true)"

echo "import: guards"
out="$(GRMC_MIGRATE_WAIT=1 ./scripts/migrate-import.sh "$S/bundle.tar" 2>&1)"; rc=$?
assert_eq "second import refuses without --force" "1" "$rc"
out="$(printf 'no\n' | GRMC_MIGRATE_WAIT=1 ./scripts/migrate-import.sh "$S/bundle.tar" --force 2>&1)"; rc=$?
assert_eq "--force aborts unless confirmed" "1" "$rc"
assert_ok "--force lists the volumes it would delete" grep -q 'grmcmigimp_pgdata' <<<"$out"
assert_ok "--force warns when the bundle came from this very Mac" grep -q 'made on THIS Mac' <<<"$out"
assert_eq "…and nothing was touched" "16" "$(vol_cat grmcmigimp_pgdata PG_VERSION)"
cp "$S/bundle.tar" "$S/damaged.tar"; cp "$S/bundle.tar.sha256" "$S/damaged.tar.sha256"
sed -i '' 's/bundle.tar$/damaged.tar/' "$S/damaged.tar.sha256"
printf 'x' >>"$S/damaged.tar"
out="$(printf 'force\n' | GRMC_MIGRATE_WAIT=1 ./scripts/migrate-import.sh "$S/damaged.tar" --force 2>&1)"; rc=$?
assert_eq "a damaged bundle is refused by its checksum" "1" "$rc"
assert_ok "…with a clear message" grep -q 'checksum mismatch' <<<"$out"

echo "import: --force redo"
docker run --rm -v grmcmigimp_pgdata:/v alpine:3 sh -c 'printf STALE >/v/stale.txt' >/dev/null
out="$(printf 'force\n' | GRMC_MIGRATE_WAIT=1 ./scripts/migrate-import.sh "$S/bundle.tar" --force 2>&1)"; rc=$?
assert_eq "--force import exits 0" "0" "$rc"
[ "$rc" -eq 0 ] || echo "$out"
assert_fails "stale data is gone" docker run --rm -v grmcmigimp_pgdata:/v alpine:3 test -e /v/stale.txt
assert_eq "restored data is back" "16" "$(vol_cat grmcmigimp_pgdata PG_VERSION)"
assert_eq "stack is up again" "running" "$(docker compose ps --format '{{.State}}' stub)"

echo "import: failure before volumes undoes the files"
clone "$S/grmcmigimp2"
cd "$S/grmcmigimp2" || exit 1
stub_compose . grmcmigimp2
printf '#!/usr/bin/env bash\necho "(stub) install-autodeploy $*"\n' >scripts/install-autodeploy.sh
# break the pull: point the stub at an image that cannot exist
sed -i '' 's|image: alpine:3|image: ghcr.io/grmc-e2e/does-not-exist:none|' docker-compose.yml
out="$(GRMC_MIGRATE_WAIT=1 ./scripts/migrate-import.sh "$S/bundle.tar" 2>&1)"; rc=$?
assert_eq "import fails when the pull fails" "1" "$rc"
assert_ok "…and says the files were removed again" grep -q 'removed again' <<<"$out"
assert_fails ".env was removed again" test -e .env
assert_fails "secrets were removed again" test -e secrets/ghcr-auth.json
assert_eq "tunnel config back to the placeholder" "" "$(git status --porcelain cloudflared/config.yml)"
assert_fails "no volume was restored" docker volume inspect grmcmigimp2_pgdata

# --- purge -----------------------------------------------------------------
echo "purge"
cd "$S/grmcmigexp" || exit 1
stub_compose . grmcmigexp     # so `down --rmi all` only ever sees the stub
cp "$S/bundle.tar" "$HOME/grmc-migration-e2e.tar"; cp "$S/bundle.tar.sha256" "$HOME/grmc-migration-e2e.tar.sha256"
out="$(printf 'no\n' | ./scripts/migrate-export.sh --purge 2>&1)"; rc=$?
assert_eq "purge aborts unless confirmed" "1" "$rc"
assert_ok "purge warns when nobody serves the hub" grep -q 'nobody is serving' <<<"$out"
assert_ok "…and still has the data" docker volume inspect grmcmigexp_pgdata
out="$(printf 'purge\n' | ./scripts/migrate-export.sh --purge 2>&1)"; rc=$?
assert_eq "purge exits 0" "0" "$rc"
[ "$rc" -eq 0 ] || echo "$out"
assert_fails "volumes are gone" docker volume inspect grmcmigexp_pgdata
assert_fails ".env is gone" test -e .env
assert_fails "secrets are gone" test -e secrets/cloudflared-creds.json
assert_eq "tunnel config reset to the placeholder" "tunnel: <TUNNEL_UUID>" "$(grep '^tunnel:' cloudflared/config.yml)"
assert_fails "bundle in HOME removed" test -e "$HOME/grmc-migration-e2e.tar"
assert_fails "…and its sidecar" test -e "$HOME/grmc-migration-e2e.tar.sha256"
assert_ok "logout went through the shim" grep -q '^docker logout ghcr.io' "$SHIM_LOG"

cd "$REPO" || exit 1
echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
