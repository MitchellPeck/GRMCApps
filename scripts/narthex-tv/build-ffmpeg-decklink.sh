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
#      so it cannot be scripted).
#
#   2. Point this at the .zip, or at the folder if you already unpacked it:
#        ./build-ffmpeg-decklink.sh ~/Downloads/Blackmagic_DeckLink_SDK_12.9.zip
#        ./build-ffmpeg-decklink.sh "~/Downloads/Blackmagic DeckLink SDK 12.9"
#      Note the folder INSIDE the zip is named differently from the zip, and
#      has spaces in it — which is why the zip is the easier thing to pass.
#
# Installs to ~/.local/bin/ffmpeg-decklink unless PREFIX says otherwise.
set -euo pipefail

SDK_ROOT="${1:-}"
PREFIX="${PREFIX:-$HOME/.local}"
# Current FFmpeg, not a release: 7.1's decklink_frame::QueryInterface refuses
# every interface with E_NOINTERFACE, and an UltraStudio Express Monitor 3G on
# Desktop Video 16.4 then rejects the very first frame with E_INVALIDARG.
# Current FFmpeg answers IID_IUnknown and the same command plays. Verified at
# b139ba1 with SDK 16.0; if a later master regresses, that commit is the known
# good one.
FFMPEG_TAG="${FFMPEG_TAG:-master}"
CC="${CC:-clang}"
SYSROOT_FLAGS=""
WORK="${WORK:-${TMPDIR:-/tmp}/narthex-ffmpeg-build}"

if [[ -z "$SDK_ROOT" ]]; then
  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
fi

# Blackmagic's zip extracts to a folder with SPACES in the name ("Blackmagic
# DeckLink SDK 12.9"), so an unquoted path arrives here as several arguments
# and we would otherwise only see the first word of it.
if [[ $# -gt 1 && -d "$*" ]]; then
  SDK_ROOT="$*"
  echo "note: read those $# arguments as one path with spaces:" >&2
  echo "      $SDK_ROOT" >&2
  echo "      (quote it next time: \"$SDK_ROOT\")" >&2
  echo >&2
fi

# Blackmagic ships a .zip, and the folder inside it is named differently from
# the zip itself — Blackmagic_DeckLink_SDK_12.9.zip unpacks to "Blackmagic
# DeckLink SDK 12.9", spaces and all. Take either, so nobody has to know that.
SDK_ZIP=""
if [[ -f "$SDK_ROOT" ]]; then
  SDK_ZIP="$SDK_ROOT"
elif [[ ! -d "$SDK_ROOT" && -f "${SDK_ROOT%.zip}.zip" ]]; then
  # They named the zip without its extension, which is what Finder shows.
  SDK_ZIP="${SDK_ROOT%.zip}.zip"
fi
if [[ -n "$SDK_ZIP" ]]; then
  command -v unzip >/dev/null || { echo "unzip is needed to read $SDK_ZIP" >&2; exit 69; }
  echo "Unpacking ${SDK_ZIP}..."
  rm -rf "$WORK/sdk"
  mkdir -p "$WORK/sdk"
  unzip -q "$SDK_ZIP" -d "$WORK/sdk"
  SDK_ROOT="$WORK/sdk"
fi

if [[ ! -d "$SDK_ROOT" ]]; then
  {
    echo "No such folder: $SDK_ROOT"
    echo
    echo "If the path has spaces in it, quote it:"
    echo "    $0 \"\$HOME/Downloads/Blackmagic DeckLink SDK 12.9\""
    echo
    echo "DeckLink SDKs I can see (a .zip is fine, no need to unpack it):"
    find "$HOME/Downloads" "$HOME/Desktop" -maxdepth 2 \
         \( -type d -o -iname '*.zip' \) -iname '*decklink*' 2>/dev/null \
      | sed 's/^/    /' || true
  } >&2
  exit 66
fi

# ── locate the headers ──────────────────────────────────────────────────────
# Blackmagic has shipped these at a few different depths over the years, so
# look rather than assume.
INCLUDE=""
for candidate in "$SDK_ROOT/Mac/include" "$SDK_ROOT/include" "$SDK_ROOT"; do
  if [[ -f "$candidate/DeckLinkAPI.h" ]]; then INCLUDE="$candidate"; break; fi
done
if [[ -z "$INCLUDE" ]]; then
  # Ask for Mac explicitly first. The SDK carries Mac, Linux and Win header
  # sets side by side, and a bare find returns whichever the filesystem lists
  # first — which really does come back Linux, and would build against the
  # wrong platform's headers without ever saying so.
  FOUND="$(find "$SDK_ROOT" -path '*/Mac/include/DeckLinkAPI.h' -print -quit 2>/dev/null || true)"
  if [[ -z "$FOUND" ]]; then
    FOUND="$(find "$SDK_ROOT" -name DeckLinkAPI.h -print -quit 2>/dev/null || true)"
  fi
  [[ -n "$FOUND" ]] && INCLUDE="$(dirname "$FOUND")"
fi
case "$INCLUDE" in
  */Linux/*|*/Win/*)
    echo "Refusing to build against $INCLUDE - those are not the Mac headers." >&2
    exit 66
    ;;
esac
if [[ -z "$INCLUDE" ]]; then
  {
    echo "Found $SDK_ROOT, but there is no DeckLinkAPI.h anywhere under it."
    echo
    echo "It contains:"
    ls -1 "$SDK_ROOT" 2>/dev/null | head -20 | sed 's/^/    /'
    echo
    echo "Expected a Mac/include folder. Did the zip extract completely, and is"
    echo "this the SDK rather than the Desktop Video installer?"
  } >&2
  exit 66
fi
echo "SDK headers: $INCLUDE"

# FFmpeg's configure WORD-SPLITS --extra-cflags when it builds compile
# commands, so "-I/…/Blackmagic DeckLink SDK 12.9/Mac/include" arrives at
# clang as four separate arguments and it complains about 'DeckLink' and 'SDK'
# not existing. No quoting on this side survives that, so copy the headers
# somewhere without spaces and point at the copy.
case "$WORK" in
  *" "*)
    echo "The build directory must not contain spaces: $WORK" >&2
    echo "Set WORK=/some/path/without/spaces and try again." >&2
    exit 78
    ;;
esac
if [[ "$INCLUDE" == *" "* ]]; then
  STAGED="${WORK}/sdk-include"
  rm -rf "$STAGED"
  mkdir -p "$STAGED"
  cp -R "$INCLUDE/." "$STAGED/"
  INCLUDE="$STAGED"
  echo "staged to:   $INCLUDE  (the original path has spaces in it)"
fi

mkdir -p "$WORK"

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
    # Any SDK builds now that capture is excluded, but an OLD one is the
    # problem it used to be the cure for. Built against 12.x headers and run
    # against a 16.x driver, the card takes the mode, plays the frames ffmpeg
    # has buffered -- one second of them -- and then freezes forever: the
    # frame-completion callback never fires, ffmpeg's free-slot count never
    # recovers, and it blocks on the next frame. Nothing in any log says so.
    # Match the SDK to the installed Desktop Video version.
    if (( API_NUM < 0x0E000000 )); then
      cat >&2 <<MSG

SDK ${PRETTY} is older than the Desktop Video driver is likely to be.

Capture is no longer built, so this WILL compile -- but an SDK several major
versions behind the installed driver is what makes a card play for exactly one
second and then sit on a frozen frame. Check the driver's version in Blackmagic
Desktop Video Setup (About), and download the matching SDK from
https://www.blackmagicdesign.com/support -- search for "Desktop Video SDK".

Set NARTHEX_ALLOW_OLD_SDK=1 to build against it anyway.
MSG
      [[ "${NARTHEX_ALLOW_OLD_SDK:-}" == "1" ]] || exit 65
    elif (( API_NUM > 0x0C090000 )); then
      echo "warning: SDK ${PRETTY} is newer than the 12.9 that is known to build;" >&2
      echo "         if it fails the same way, drop back to 12.4.2." >&2
    fi
  fi
fi

# ── build ───────────────────────────────────────────────────────────────────
command -v git >/dev/null || { echo "git is required." >&2; exit 69; }

mkdir -p "$WORK"

# Check the toolchain before cloning 18 MB and burning two minutes on it.
# FFmpeg's own failure for this is "gcc is unable to create an executable file
# / C compiler test failed", which does not say what to do about it; on macOS
# it is nearly always Command Line Tools that have gone stale against the OS.
printf 'int main(void){return 0;}\n' > "${WORK}/cc-test.c"

# Can the toolchain link at all, and against which SDK?
cc_links() {
  local sysroot="${1:-}"
  if [[ -n "$sysroot" ]]; then
    "$CC" -isysroot "$sysroot" "${WORK}/cc-test.c" -o "${WORK}/cc-test" 2>"${WORK}/cc-test.log"
  else
    "$CC" "${WORK}/cc-test.c" -o "${WORK}/cc-test" 2>"${WORK}/cc-test.log"
  fi
}

if ! cc_links ""; then
  FIRST_ERROR="$(cat "${WORK}/cc-test.log")"

  # A Mac can end up with an SDK NEWER than the linker that has to read it,
  # which fails as "tapi error: malformed file / unknown architecture". An
  # older SDK installed alongside it usually links fine, so try them oldest
  # first rather than sending someone off to reinstall Xcode.
  # Order matters. MacOSX.sdk is a symlink to whichever is newest, which on
  # this kind of machine is the broken one, so resolve it and sort properly:
  # the SDK matching the running macOS first, then older ones newest-first,
  # and anything NEWER than the OS last of all.
  OS_MAJOR="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)"
  OS_MAJOR="${OS_MAJOR:-0}"
  SDK_EXACT=""; SDK_OLDER=""; SDK_NEWER=""; SEEN=""
  for sdk in /Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk \
             /Applications/Xcode*.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX*.sdk; do
    [[ -d "$sdk" ]] || continue
    real="$(cd "$sdk" && pwd -P)"
    case " ${SEEN} " in *" ${real} "*) continue ;; esac
    SEEN="${SEEN} ${real}"
    ver="$(basename "$real")"; ver="${ver#MacOSX}"; ver="${ver%.sdk}"
    major="${ver%%.*}"
    if [[ "$major" == "$OS_MAJOR" ]]; then
      SDK_EXACT="${SDK_EXACT}${ver}|${real}"$'\n'
    elif [[ "$major" =~ ^[0-9]+$ ]] && (( major < OS_MAJOR )); then
      SDK_OLDER="${SDK_OLDER}${ver}|${real}"$'\n'
    else
      SDK_NEWER="${SDK_NEWER}${ver}|${real}"$'\n'
    fi
  done

  WORKING_SDK=""
  ORDERED="$( { printf '%s' "$SDK_EXACT" | sort -t'|' -k1,1Vr
                printf '%s' "$SDK_OLDER" | sort -t'|' -k1,1Vr
                printf '%s' "$SDK_NEWER" | sort -t'|' -k1,1V; } | grep -v '^$' || true)"
  while IFS='|' read -r ver sdk; do
    [[ -n "${sdk:-}" ]] || continue
    if cc_links "$sdk"; then WORKING_SDK="$sdk"; break; fi
  done <<< "$ORDERED"

  if [[ -n "$WORKING_SDK" ]]; then
    echo "note: the default SDK cannot link, but ${WORKING_SDK} can - using that." >&2
    echo >&2
    export SDKROOT="$WORKING_SDK"
    # SDKROOT alone is not enough: configure runs its own compiler test and it
    # failed there even after the preflight passed. Pass -isysroot explicitly
    # on every flag set instead of relying on the environment.
    SYSROOT_FLAGS="-isysroot ${WORKING_SDK}"
  else
    {
      echo "${CC} cannot build a trivial C program, so FFmpeg has no chance:"
      echo
      echo "${FIRST_ERROR}" | sed 's/^/    /'
      echo
      if grep -q "tapi error\|unknown architecture" <<<"${FIRST_ERROR}"; then
        echo "That particular error means the SDK is NEWER than the linker that"
        echo "has to read it, and no other installed SDK links either. Installing"
        echo "the Command Line Tools matching this macOS is the fix:"
        echo "    https://developer.apple.com/download/all/  (search: Command Line Tools)"
        echo "A full Xcode also carries its own SDKs; if one is installed, try:"
        echo "    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
      else
        echo "On macOS this is usually stale Command Line Tools. Reinstall:"
        echo "    sudo rm -rf /Library/Developer/CommandLineTools"
        echo "    sudo xcode-select --install"
      fi
      echo
      echo "Current toolchain:"
      echo "    macOS             -> $(sw_vers -productVersion 2>/dev/null || echo "not macOS")"
      echo "    xcode-select -p   -> $(xcode-select -p 2>/dev/null || echo "not available")"
      echo "    sdk path          -> $(xcrun --show-sdk-path 2>/dev/null || echo "not available")"
      echo "    SDKs installed    ->"
      ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk 2>/dev/null | sed 's/^/        /' \
        || echo "        none found"
      echo
      echo "You can also point this at a specific one yourself:"
      echo "    SDKROOT=/path/to/MacOSX15.sdk $0 <sdk>"
    } >&2
    exit 70
  fi
fi
rm -f "${WORK}/cc-test" "${WORK}/cc-test.c" "${WORK}/cc-test.log"

# FFmpeg needs nasm to assemble its x86 SIMD. Apple Silicon is aarch64, so the
# check never runs there; an Intel Mac needs it installed.
if [[ "$(uname -m)" != "arm64" ]] && ! command -v nasm >/dev/null; then
  echo "nasm is required on Intel Macs: brew install nasm" >&2
  exit 69
fi

cd "$WORK"

# Reuse a checkout only when it is the version asked for. Keeping whatever was
# cloned first made FFMPEG_TAG silently do nothing: a rebuild "at master"
# produced 7.1 again, reported 7.1 in its own output, and was read as evidence
# that a newer FFmpeg behaved no differently.
HAVE_TAG=""
if [[ -d FFmpeg ]]; then
  HAVE_TAG="$(cat FFmpeg/.narthex-tag 2>/dev/null || echo unknown)"
  if [[ "$HAVE_TAG" != "$FFMPEG_TAG" ]]; then
    echo "Have FFmpeg ${HAVE_TAG}, want ${FFMPEG_TAG} -- refetching."
    rm -rf FFmpeg
  fi
fi

if [[ ! -d FFmpeg ]]; then
  echo "Fetching FFmpeg ${FFMPEG_TAG}..."
  git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git
  echo "$FFMPEG_TAG" > FFmpeg/.narthex-tag
fi
cd FFmpeg

# Say which version is being built, so the binary's own Lavf/Lavc numbers can
# be checked against what was asked for.
echo "Building FFmpeg ${FFMPEG_TAG} ($(git rev-parse --short HEAD 2>/dev/null || echo '?'))"

# ── shim IID_IUnknown when the Mac SDK does not define it ───────────────────
# Current FFmpeg answers QueryInterface for IID_IUnknown properly; 7.1 refused
# every interface with E_NOINTERFACE. Blackmagic's Mac SDK does not define that
# identifier -- on macOS the value lives behind CFUUIDGetUUIDBytes(IUnknownUUID)
# -- so the build stops with:
#
#     decklink_enc.cpp:120: error: use of undeclared identifier 'IID_IUnknown'
#
# Supply it rather than drop back to a version that cannot answer the query. A
# file-scope constant, because DECKLINK_IsEqualIID takes the address of both
# operands and a temporary has none.
ENC="libavdevice/decklink_enc.cpp"
if grep -q "IID_IUnknown" "$ENC" 2>/dev/null &&
   ! grep -rq "IID_IUnknown" "$INCLUDE" 2>/dev/null; then
  echo "SDK does not define IID_IUnknown; adding it to ${ENC}."
  python3 - "$ENC" <<'PATCH'
import sys
path = sys.argv[1]
source = open(path).read()
if "GRMC_IID_IUnknown" in source:
    sys.exit(0)
anchor = '#include "decklink_enc.h"'
if anchor not in source:
    sys.exit("could not find %s in %s" % (anchor, path))
shim = anchor + """

/* Added by GRMCApps build-ffmpeg-decklink.sh: Blackmagic's Mac SDK does not
   define IID_IUnknown. On macOS it is the bytes of the CFPlugIn IUnknown UUID,
   and it must be an object with an address, because DECKLINK_IsEqualIID
   compares &a with &b. */
#if !defined(_WIN32) && !defined(IID_IUnknown)
static const REFIID GRMC_IID_IUnknown = CFUUIDGetUUIDBytes(IUnknownUUID);
#define IID_IUnknown GRMC_IID_IUnknown
#endif
"""
open(path, "w").write(source.replace(anchor, shim, 1))
PATCH
fi

# Stock FFmpeg with no external libraries is everything this needs: it DECODES
# H.264, MJPEG and PNG natively, scales and pads natively, and writes rawvideo.
# Nothing is encoded to a compressed format at playout, so no x264, no GPL.
echo "Configuring..."
if ! ./configure \
  --prefix="$PREFIX" \
  --cc="$CC" \
  --enable-decklink \
  `# Capture is the only part that will not compile against a current SDK --` \
  `# GetBytes and the input allocator were removed after 12.4 and FFmpeg still` \
  `# calls them. This program only ever OUTPUTS, so leave capture out and the` \
  `# headers can match the installed driver. That matters: built against 12.x` \
  `# headers and run against a 16.x driver, playback starts, plays the frames` \
  `# ffmpeg buffered and then stops forever, because the frame-completion` \
  `# callback never fires and ffmpeg's free-slot count never recovers.` \
  --disable-indev=decklink \
  --extra-cflags="-I$INCLUDE ${SYSROOT_FLAGS}" \
  --extra-cxxflags="-I$INCLUDE ${SYSROOT_FLAGS}" \
  --extra-ldflags="${SYSROOT_FLAGS}" \
  --disable-doc \
  --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
  --disable-ffplay \
  --progs-suffix=-decklink
then
  # "See ffbuild/config.log" is useless to anyone standing at a terminal, and
  # the real reason is always in the last few lines of it.
  {
    echo
    echo "configure failed. The end of ffbuild/config.log, which says why:"
    echo
    tail -40 ffbuild/config.log 2>/dev/null | sed 's/^/    /' || echo "    (no config.log)"
  } >&2
  exit 71
fi

echo "Building (this takes a while)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
make install

BIN="$PREFIX/bin/ffmpeg-decklink"
echo
echo "Installed: $BIN"
echo

# The SDK we just built against is headers only. Talking to the hardware needs
# Blackmagic's Desktop Video DRIVER, which is a separate download, and without
# it the first thing anyone tries fails with "Could not create DeckLink
# iterator" — which does not obviously mean "install the driver".
if ! "$BIN" -hide_banner -sinks decklink >/dev/null 2>&1; then
  cat <<MSG
The card is not reachable yet. Most likely the Desktop Video DRIVER is not
installed - that is a separate download from the SDK, which was only headers:

    https://www.blackmagicdesign.com/support   (search "Desktop Video")

After installing it you must also approve the system extension in
System Settings > Privacy & Security, then reboot. "Blackmagic Desktop Video
Setup" should then list the device.

Note this build requires the driver to be ${PRETTY:-12.x} or newer, since that
is the SDK it was compiled against.

Then check again with:
    $BIN -sinks decklink
MSG
else
  echo "The card is visible:"
  "$BIN" -hide_banner -sinks decklink 2>&1 | sed 's/^/    /'
fi

echo
echo "Then point playout.py at it:"
echo "    ./playout.py --url '<player link>' --ffmpeg '$BIN'"
