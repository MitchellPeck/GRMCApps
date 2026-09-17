#!/usr/bin/env bash
# Collect everything needed to diagnose an /api/extract failure in the expenses
# app. Run on the Docker host, from the repo root:
#
#   ./scripts/diagnose-expenses.sh            # state snapshot only
#   ./scripts/diagnose-expenses.sh capture    # snapshot, then follow logs while
#                                             # you reproduce the failure
#   ./scripts/diagnose-expenses.sh isolate ~/failing-receipt.pdf
#                                             # same request through the public
#                                             # URL, timed — the decisive test
set -uo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.remote.yml)
MODE="${1:-state}"

rule() { printf '\n=== %s ===\n' "$1"; }

state() {
  local id
  id="$("${COMPOSE[@]}" ps -q expenses 2>/dev/null)"
  if [ -z "$id" ]; then
    echo "The expenses container is not running."
    return
  fi

  rule "container state"
  # oomKilled=true or a climbing restart count means it is being killed, which
  # is a different problem from anything in the request path.
  docker inspect --format \
'restarts={{.RestartCount}}
exitCode={{.State.ExitCode}}
oomKilled={{.State.OOMKilled}}
status={{.State.Status}}
startedAt={{.State.StartedAt}}
memLimit={{.HostConfig.Memory}}' "$id"

  rule "docker engine"
  docker info --format 'memTotal={{.MemTotal}} ncpu={{.NCPU}}' 2>/dev/null

  rule "live usage"
  docker stats --no-stream --format \
    'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}' \
    | grep -E 'NAME|expenses|whisper|postgres' || true

  rule "expenses log (last 60)"
  "${COMPOSE[@]}" logs --tail=60 expenses
}

capture() {
  local out
  out="/tmp/expenses-diag-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$out"
  state > "$out/state.txt" 2>&1
  echo "State snapshot: $out/state.txt"

  "${COMPOSE[@]}" logs -f --tail=0 expenses    > "$out/expenses.log" 2>&1 &
  local p1=$!
  "${COMPOSE[@]}" logs -f --tail=0 traefik     > "$out/traefik.log"  2>&1 &
  local p2=$!
  "${COMPOSE[@]}" logs -f --tail=0 cloudflared > "$out/tunnel.log"   2>&1 &
  local p3=$!

  echo
  echo "Capturing. Reproduce the failure in the browser now."
  echo "Note roughly how long it takes to fail, then press Enter."
  read -r _
  sleep 2
  kill "$p1" "$p2" "$p3" 2>/dev/null
  wait "$p1" "$p2" "$p3" 2>/dev/null

  rule "EXPENSES"; cat "$out/expenses.log"
  rule "TRAEFIK";  tail -40 "$out/traefik.log"
  rule "TUNNEL";   tail -40 "$out/tunnel.log"
  echo
  echo "Saved in $out"
}

isolate() {
  local pdf="${2:-$HOME/failing-receipt.pdf}"
  if [ ! -f "$pdf" ]; then
    echo "No PDF at $pdf"
    echo "Usage: $0 isolate /path/to/failing-receipt.pdf"
    return 1
  fi
  ls -lh "$pdf"

  rule "through the public URL (timed)"
  # total= is the number that matters. Near 100s implicates Cloudflare's edge
  # timeout; a fast failure with an empty body points inside the stack.
  curl -sS -o /tmp/expenses-resp.txt -w \
    'http=%{http_code}  total=%{time_total}s  connect=%{time_connect}s  tls=%{time_appconnect}s\n' \
    -X POST "https://expenses.$(grep -E '^BASE_DOMAIN=' .env | cut -d= -f2)/api/extract" \
    -F "files=@${pdf};type=application/pdf"

  rule "response body (first 400 bytes)"
  head -c 400 /tmp/expenses-resp.txt; echo

  rule "what the app logged while that ran"
  "${COMPOSE[@]}" logs --tail=40 expenses
}

case "$MODE" in
  state)   state ;;
  capture) capture ;;
  isolate) isolate "$@" ;;
  *) echo "Usage: $0 [state|capture|isolate <pdf>]"; exit 1 ;;
esac
