#!/usr/bin/env bash
#
# Build an ffmpeg that can output to a DeckLink / UltraStudio.
#
# WHY NOT `brew install ffmpegdecklink`
# -------------------------------------
# As of September 2026 that formula does not build. FFmpeg's decklink CAPTURE
# code — which this app never uses; we only ever output — calls two things
# Blackmagic removed after DeckLink SDK 12.4:
#
#     IDeckLinkVideoFrame::GetBytes             (moved to IDeckLinkVideoBuffer)
#     IDeckLinkInput::SetVideoInputFrameMemoryAllocator   (deleted)
#
# The `decklinksdk` formula installs SDK 15, so the build dies with
# "no member named 'GetBytes' in 'IDeckLinkVideoInputFrame'". FFmpeg master
# still has the same unguarded calls, so a NEWER ffmpeg does not fix it — the
# SDK has to be an older one.
#
# The SDK is needed only at BUILD time, for headers. The finished binary talks
# to whichever Desktop Video driver is installed, so building against SDK 12.x
# and running against a current driver is normal and is what this does.
#
# USAGE
# -----
#   1. Download a 12.x "Blackmagic DeckLink SDK" from
#        https://www.blackmagicdesign.com/support
#      (search "Desktop Video SDK"; the download is behind a name/email form,
#      so it cannot be scripted). Unzip it anywhere.
#
#   2. ./build-ffmpeg-decklink.sh ~/Downloads/Blackmagic_DeckLink_SDK_12.4.2
#
# Installs to ~/.local/bin/ffmpeg-decklink unless PREFIX says otherwise.
set -euo pipefail

SDK_ROOT="${1:-}"
PREFIX="${PREFIX:-$HOME/.local}"
FFMPEG_TAG="${FFMPEG_TAG:-n7.1}"
WORK="${WORK:-${TMPDIR:-/tmp}/narthex-ffmpeg-build}"

if [[ -z "$SDK_ROOT" ]]; then
  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
fi

# ── locate the headers ──────────────────────────────────────────────────────
# Blackmagic has shipped these at a few different depths over the years, so
# look rather than assume.
INCLUDE=""
for candidate in "$SDK_ROOT/Mac/include" "$SDK_ROOT/include" "$SDK_ROOT"; do
  if [[ -f "$candidate/DeckLinkAPI.h" ]]; then INCLUDE="$candidate"; break; fi
done
if [[ -z "$INCLUDE" ]]; then
  INCLUDE="$(dirname "$(find "$SDK_ROOT" -name DeckLinkAPI.h -print -quit 2>/dev/null || true)")"
fi
if [[ ! -f "$INCLUDE/DeckLinkAPI.h" ]]; then
  echo "Couldn't find DeckLinkAPI.h under $SDK_ROOT" >&2
  echo "Point this at the unzipped SDK folder (the one containing Mac/include)." >&2
  exit 66
fi
echo "SDK headers: $INCLUDE"

# ── refuse an SDK that is already known not to compile ──────────────────────
# Far better to say so now than fifteen minutes into a build.
VERSION_HEADER="$INCLUDE/DeckLinkAPIVersion.h"
if [[ -f "$VERSION_HEADER" ]]; then
  API_HEX="$(sed -n 's/.*BLACKMAGIC_DECKLINK_API_VERSION[[:space:]]*0x\([0-9A-Fa-f]*\).*/\1/p' \
             "$VERSION_HEADER" | head -1)"
  if [[ -n "$API_HEX" ]]; then
    API_NUM=$((16#$API_HEX))
    PRETTY="$(( (API_NUM >> 24) & 0xFF )).$(( (API_NUM >> 16) & 0xFF )).$(( (API_NUM >> 8) & 0xFF ))"
    echo "SDK version: $PRETTY"
    # 14.0 is where Blackmagic moved GetBytes onto IDeckLinkVideoBuffer and
    # dropped the input allocator; 12.9 is the newest reported to still build.
    # In between is untested rather than known-bad, so warn instead of refusing.
    if (( API_NUM >= 0x0E000000 )); then
      cat >&2 <<MSG

SDK $PRETTY is too new. FFmpeg's decklink capture code does not compile
against 14.x or later — you will get exactly the failure this script exists
to avoid:

    no member named 'GetBytes' in 'IDeckLinkVideoInputFrame'
    no member named 'SetVideoInputFrameMemoryAllocator' in 'IDeckLinkInput'

Download a 12.x SDK (12.4.2 is a known-good one) from
https://www.blackmagicdesign.com/support and point this script at that. The
Desktop Video driver on the Mac can stay current — only these build-time
headers need to be old.
MSG
      exit 65
    elif (( API_NUM > 0x0C090000 )); then
      echo "warning: SDK $PRETTY is newer than the 12.9 that is known to build;" >&2
      echo "         if it fails the same way, drop back to 12.4.2." >&2
    fi
  fi
fi

# ── build ───────────────────────────────────────────────────────────────────
command -v git >/dev/null || { echo "git is required." >&2; exit 69; }

# FFmpeg needs nasm to assemble its x86 SIMD. Apple Silicon is aarch64, so the
# check never runs there; an Intel Mac needs it installed.
if [[ "$(uname -m)" != "arm64" ]] && ! command -v nasm >/dev/null; then
  echo "nasm is required on Intel Macs: brew install nasm" >&2
  exit 69
fi
mkdir -p "$WORK"
cd "$WORK"

if [[ ! -d FFmpeg ]]; then
  echo "Fetching FFmpeg $FFMPEG_TAG…"
  git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git
fi
cd FFmpeg

# Stock FFmpeg with no external libraries is everything this needs: it DECODES
# H.264, MJPEG and PNG natively, scales and pads natively, and writes rawvideo.
# Nothing is encoded to a compressed format at playout, so no x264, no GPL.
echo "Configuring…"
./configure \
  --prefix="$PREFIX" \
  --enable-decklink \
  --extra-cflags="-I$INCLUDE" \
  --extra-cxxflags="-I$INCLUDE" \
  --disable-doc \
  --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
  --disable-ffplay \
  --progs-suffix=-decklink

echo "Building (this takes a while)…"
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
make install

BIN="$PREFIX/bin/ffmpeg-decklink"
echo
echo "Installed: $BIN"
echo
echo "Check the card is visible:"
echo "    $BIN -sinks decklink"
echo
echo "Then point playout.py at it:"
echo "    ./playout.py --url '<player link>' --ffmpeg '$BIN'"
