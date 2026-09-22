#!/usr/bin/env bash
# Launch the narthex TV player full screen on the Mac that drives the display.
#
#   ./kiosk.sh "https://tv.grmc.app/player?t=<screen token>"
#
# Get the URL from Narthex TV -> Screens -> Copy link. It contains that
# screen's token, which is the only credential the TV has: the player routes
# sit outside the hub's Google sign-in because a television cannot complete
# one. Treat the URL like a password.
#
# Optional second argument positions the window on a second display, e.g.
#   ./kiosk.sh "<url>" 1920,0
# Find the origin of each display with:
#   system_profiler SPDisplaysDataType | grep -i resolution
set -euo pipefail

URL="${1:-}"
POSITION="${2:-}"

if [[ -z "$URL" ]]; then
  echo "usage: $0 <player URL> [window-position-x,y]" >&2
  exit 64
fi

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -x "$CHROME" ]]; then
  echo "Google Chrome isn't installed at $CHROME." >&2
  echo "Chromium or Edge work identically — point CHROME at one of those." >&2
  exit 69
fi

# A dedicated profile directory keeps the kiosk out of anyone's signed-in
# Chrome, and keeps its own localStorage (where the player caches the last
# schedule so a reboot before the network is up still shows something).
PROFILE="${HOME}/Library/Application Support/GRMC/narthex-tv-kiosk"
mkdir -p "$PROFILE"

ARGS=(
  --user-data-dir="$PROFILE"
  --kiosk "$URL"
  # Nothing here is ever meant to interrupt the picture.
  --noerrdialogs
  --disable-infobars
  --disable-session-crashed-bubble
  --disable-features=TranslateUI,InfiniteSessionRestore
  --no-first-run
  --no-default-browser-check
  --check-for-update-interval=604800
  # The media has no audio track at all, but this removes any doubt about a
  # clip being blocked from starting on its own.
  --autoplay-policy=no-user-gesture-required
  # A kiosk that is never looked at by a person should not be throttled as if
  # it were a background tab.
  --disable-background-timer-throttling
  --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding
  --overscroll-history-navigation=0
)

if [[ -n "$POSITION" ]]; then
  ARGS+=(--window-position="$POSITION")
fi

exec "$CHROME" "${ARGS[@]}"
