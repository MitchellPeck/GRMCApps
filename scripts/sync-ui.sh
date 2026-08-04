#!/usr/bin/env bash
# Copy the shared UI into each surface's served dir for local (non-Docker) dev.
# Mirrors what every Dockerfile does at build time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/shared/ui"
for d in apps/approvals apps/meeting-minutes apps/social-posts apps/whoami hub; do
  DEST="$ROOT/$d/src/public/assets"
  mkdir -p "$DEST/fonts"
  cp "$SRC/grmc.css" "$DEST/grmc.css"
  cp "$SRC/grmc-nav.js" "$DEST/grmc-nav.js"
  cp "$SRC/fonts/"*.woff2 "$DEST/fonts/"
  echo "synced -> $d/src/public/assets"
done
