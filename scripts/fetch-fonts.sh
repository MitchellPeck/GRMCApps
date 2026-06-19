#!/usr/bin/env bash
# Reproducibly download self-hosted woff2 (latin subset) for Playfair Display
# + Inter. The Google CSS2 endpoint returns several subset blocks per weight
# (latin, latin-ext, cyrillic, ...), each preceded by a /* <subset> */ comment.
# We request ONE weight at a time and extract the woff2 URL from the block
# labelled /* latin */ — robust against block ordering and extra subsets.
set -euo pipefail
DEST="$(cd "$(dirname "$0")/.." && pwd)/shared/ui/fonts"
mkdir -p "$DEST"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

fetch_one() { # <family-query> <weight> <out-basename>
  local css url
  css=$(curl -sf -H "User-Agent: $UA" "https://fonts.googleapis.com/css2?family=${1}:wght@${2}&display=swap")
  # From the /* latin */ marker, take the first woff2 URL that follows.
  url=$(printf '%s\n' "$css" | awk '/\/\* latin \*\//{f=1} f && /url\(/{match($0,/https:[^)]+woff2/); print substr($0,RSTART,RLENGTH); exit}')
  if [ -z "$url" ]; then echo "ERROR: no latin woff2 for ${1} ${2}" >&2; exit 1; fi
  curl -sf -o "$DEST/${3}.woff2" "$url"
  echo "  -> ${3}.woff2"
}

echo "Playfair Display..."
for w in 500 600 700; do fetch_one "Playfair+Display" "$w" "playfair-$w"; done
echo "Inter..."
for w in 400 500 600 700; do fetch_one "Inter" "$w" "inter-$w"; done

echo "Done. Files in $DEST"
ls -1 "$DEST"
