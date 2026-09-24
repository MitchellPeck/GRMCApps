#!/usr/bin/env python3
"""
Narthex TV -> Blackmagic DeckLink / UltraStudio playout.

Runs on the Mac that has the UltraStudio attached, and needs nothing but
python3 (which macOS ships) and an ffmpeg built with --enable-decklink:

    brew tap amiaopensource/amiaos && brew install ffmpegdecklink

WHY IT IS SHAPED LIKE THIS
--------------------------
`ffmpeg -f decklink` CLOSES the output device when its input ends. One ffmpeg
per slide would therefore drop the signal every few seconds and the television
would re-sync — a black flash between every photo. So:

  * ONE long-lived ffmpeg owns the device for the life of the process. It reads
    raw uyvy422 frames from a pipe and never sees an end-of-input, so the
    signal is continuous from the moment it starts.

  * A feeder decodes ONE item at a time into that pipe — a photo held for its
    duration, a slide, a video. Items are normalised to the output canvas as
    they are played, not when they are uploaded, so the per-item "seconds" in
    the app stays a live setting rather than something baked into a file.

  * Because the device paces the pipe (the outer ffmpeg blocks until the card
    wants the next frame), the feeder self-times. There is no sleep anywhere.

  * Bytes are copied in EXACT frame-sized units. Raw video over a pipe has no
    framing, so being interrupted mid-frame would shift every following frame
    and tear the picture permanently.

A schedule change cuts in at once: the inner decode is killed, the outer ffmpeg
keeps the device open, and the next item's frames start flowing. One repeated
frame, no signal loss.

This reads the SAME /api/player/plan the browser player reads, so the schedule,
the operating hours and the blackout all behave identically — there is no
second copy of that logic to drift.

    ./playout.py --url 'https://tv.grmc.app/player?t=<token>'
    ./playout.py --url 'http://127.0.0.1:3010/player?t=...' \
                 --device 'UltraStudio Express Monitor 3G' --mode 1920x1080@30
"""

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# ── pure helpers (exercised by test_playout.py) ─────────────────────────────

def parse_mode(text):
    """'1920x1080@30' -> (1920, 1080, 30.0). Raises ValueError on anything else."""
    try:
        size, _, rate = text.partition("@")
        width, _, height = size.partition("x")
        w, h, fps = int(width), int(height), float(rate or 30)
    except ValueError:
        raise ValueError(f"{text!r} is not a mode like 1920x1080@30")
    if w <= 0 or h <= 0 or fps <= 0:
        raise ValueError(f"{text!r} is not a mode like 1920x1080@30")
    return w, h, fps


def frame_bytes(width, height):
    """uyvy422 is exactly two bytes per pixel. This is the unit we copy in."""
    return width * height * 2


def split_player_url(url):
    """
    Takes the link straight out of Screens -> Copy link and returns
    (origin, token), so nobody has to hand-assemble an API base.
    """
    parts = urllib.parse.urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("The player URL must start with http:// or https://")
    query = urllib.parse.parse_qs(parts.query)
    token = (query.get("t") or query.get("token") or [""])[0]
    if not token:
        raise ValueError("That URL has no ?t=<token> on it — copy it from Screens.")
    return f"{parts.scheme}://{parts.netloc}", token


def fit_filter(fit, width, height, background="black"):
    """
    Put any source on the output canvas exactly.

    'contain' letterboxes the whole picture; 'cover' fills the screen and loses
    the edges. Either way the result is exactly width x height, which is what
    lets clips be spliced into one continuous raw stream.
    """
    if fit == "cover":
        geometry = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height}"
        )
    else:
        geometry = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={background}"
        )
    return f"{geometry},format=uyvy422,setsar=1"


def seconds_for(frame, default_seconds):
    """A frame's duration in seconds, or None to play a video to its own end."""
    ms = frame.get("ms")
    if ms is None:
        return None if frame.get("kind") == "video" else default_seconds
    return max(0.5, float(ms) / 1000.0)


def input_args(frame, path, width, height, fps):
    """The ffmpeg input flags for one item, before the filter chain."""
    kind = frame.get("kind")
    duration = seconds_for(frame, 10.0)

    if path is None:
        # Blackout, an empty playlist, or an asset we could not fetch. Never a
        # dead pipe: the screen shows black and the loop carries on.
        return [
            "-f", "lavfi",
            "-t", f"{duration if duration else 1.0:.3f}",
            "-i", f"color=c=black:s={width}x{height}:r={fps}",
        ]
    if kind == "video":
        args = ["-i", path]
        if duration is not None:
            # A per-item duration on a video is a cap, so it trims rather than
            # stretches — the same rule the browser player follows.
            args = ["-t", f"{duration:.3f}"] + args
        return args
    return ["-loop", "1", "-t", f"{duration:.3f}", "-i", path]


def outer_command(ffmpeg, device, width, height, fps):
    """
    The command for the one process that owns the card.

    Two things here are not free choices, and getting either wrong ends with
    the device refusing the stream rather than showing a wrong picture:

    - **The output codec must be `wrapped_avframe`.** FFmpeg's DeckLink muxer
      accepts only `v210` or a wrapped frame in `uyvy422`; anything else,
      `rawvideo` included, is rejected at header-write time with "Unsupported
      codec type!". The pipe on the *input* side is genuinely raw, so the two
      halves of this command disagree on purpose.
    - **Silent stereo at 48 kHz is attached** because the muxer wants an audio
      stream and the card's clock is fixed at that rate. The narthex screen has
      no speakers, so it is silence.
    """
    return [
        ffmpeg, "-hide_banner", "-loglevel", "warning",
        "-f", "rawvideo", "-pix_fmt", "uyvy422",
        "-s", f"{width}x{height}", "-r", f"{fps:g}",
        "-i", "pipe:0",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-c:v", "wrapped_avframe", "-pix_fmt", "uyvy422",
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
        "-f", "decklink", device,
    ]


def describe_frame(frame):
    """One line for the log: what this item is and how long it should last."""
    if frame is None:
        return "black"
    kind = frame.get("kind") or "?"
    title = frame.get("title") or frame.get("url") or ""
    ms = frame.get("ms")
    span = "to its end" if ms is None else f"{ms} ms"
    page = frame.get("page")
    if page:
        kind = f"{kind} page {page}"
    return f"{kind} {title} ({span})".strip()


def cache_name(url):
    """A stable local filename for an asset URL, ignoring its access token."""
    stripped = url.split("?", 1)[0]
    digest = hashlib.sha256(stripped.encode("utf-8")).hexdigest()[:24]
    suffix = os.path.splitext(urllib.parse.urlparse(stripped).path)[1][:8]
    return digest + suffix


def plan_changed(old, new):
    """
    (rebuild, immediately). A different source — a new schedule entry taking
    the screen, or the operating hours flipping — cuts in at once. An edit
    within the same airing waits for the current item to finish, so nobody
    saving a caption makes the screen jump.
    """
    if old is None:
        return True, True
    if old.get("sourceKey") != new.get("sourceKey"):
        return True, True
    if old.get("revision") != new.get("revision"):
        return True, False
    return False, False


def which_ffmpeg(name):
    """
    Resolve the ffmpeg to use, and say something useful if it is not there —
    the alternative is a FileNotFoundError from deep inside the playback loop
    once the card is already open.
    """
    path = os.path.expanduser(name)
    if os.path.isabs(path) or path.startswith("."):
        if not os.access(path, os.X_OK):
            raise SystemExit(
                f"No ffmpeg at {path}.\n"
                "Build one with:  ./build-ffmpeg-decklink.sh <path to a 12.x DeckLink SDK>\n"
                "or point --ffmpeg at an existing build with --enable-decklink."
            )
        return path
    found = shutil.which(path)
    if not found:
        raise SystemExit(f"{name} is not on PATH. See build-ffmpeg-decklink.sh.")
    return found


# ── the running program ─────────────────────────────────────────────────────

class Playout:
    def __init__(self, args):
        self.origin, self.token = split_player_url(args.url)
        self.width, self.height, self.fps = parse_mode(args.mode)
        self.device = args.device
        self.ffmpeg = which_ffmpeg(args.ffmpeg)
        self.cache_dir = os.path.expanduser(args.cache)
        self.background = args.background
        self.verbose = args.verbose

        self.frame_size = frame_bytes(self.width, self.height)
        self.plan = None
        self.plan_lock = threading.Lock()
        self.last_heartbeat = 0.0
        self.interrupt = threading.Event()   # cut the current item short
        self.stopping = threading.Event()
        self.outer = None

        os.makedirs(self.cache_dir, exist_ok=True)

    def log(self, message):
        print(f"[narthex-playout] {message}", flush=True)

    @staticmethod
    def takeover_active(plan):
        return bool(plan and plan.get("takeover", {}).get("active"))

    def debug(self, message):
        if self.verbose:
            self.log(message)

    # ── the device ──────────────────────────────────────────────────────────

    def start_outer(self):
        """Open the card. See outer_command for why it is built the way it is."""
        command = outer_command(self.ffmpeg, self.device,
                                self.width, self.height, self.fps)
        self.debug("outer: " + " ".join(command))
        self.outer = subprocess.Popen(command, stdin=subprocess.PIPE)
        self.log(f"opened {self.device} at {self.width}x{self.height}@{self.fps:g}")

    def outer_alive(self):
        return self.outer is not None and self.outer.poll() is None

    # ── talking to the app ──────────────────────────────────────────────────

    def api(self, path):
        url = f"{self.origin}{path}"
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode({"t": self.token})
        with urllib.request.urlopen(url, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))

    def heartbeat(self, plan):
        """
        Tell the app this screen is alive and what it is showing.

        The Screens tab is the first place anybody looks when somebody says the
        TV is stuck, and without this it reports a screen driven through the
        card as never seen — which is worse than no information, because it
        looks like a fault.
        """
        if time.time() - self.last_heartbeat < 60:
            return
        self.last_heartbeat = time.time()
        playing = "(EMERGENCY MESSAGE)" if self.takeover_active(plan) else (
            "(outside opening hours)" if not plan.get("power", {}).get("on", True)
            else plan.get("playlistName") or ""
        )
        body = json.dumps({"revision": plan.get("revision", ""), "playing": playing}).encode()
        url = f"{self.origin}/api/player/heartbeat?" + urllib.parse.urlencode({"t": self.token})
        request = urllib.request.Request(
            url, data=body, headers={"content-type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=10):
                pass
        except (urllib.error.URLError, OSError):
            pass   # the screen does not care whether this lands

    def poll_forever(self):
        while not self.stopping.is_set():
            try:
                body = self.api("/api/player/plan")
                new = body.get("plan") if body.get("ok") else None
                if new:
                    with self.plan_lock:
                        old = self.plan
                        rebuild, at_once = plan_changed(old, new)
                        self.plan = new
                    if rebuild:
                        # An emergency is the one thing here worth a line in
                        # the log at normal verbosity.
                        if self.takeover_active(new) and not self.takeover_active(old):
                            self.log("EMERGENCY MESSAGE on screen: "
                                     + str(new.get("takeover", {}).get("headline", "")))
                        elif self.takeover_active(old) and not self.takeover_active(new):
                            self.log("emergency message cleared")
                        self.debug(f"plan {new.get('revision')} "
                                   f"({'cut now' if at_once else 'at next item'})")
                        if at_once:
                            self.interrupt.set()
                    self.heartbeat(new)
            except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
                # Keep playing the last plan from cache. A narthex screen that
                # goes black because the server hiccuped is the worse failure.
                self.debug(f"poll failed ({exc}); keeping the last plan")
            delay = 10
            with self.plan_lock:
                if self.plan:
                    delay = int(self.plan.get("display", {}).get("pollSeconds") or 10)
            self.stopping.wait(max(3, delay))

    def asset(self, url):
        """Fetch an asset once and keep it; the bytes at a URL never change."""
        target = os.path.join(self.cache_dir, cache_name(url))
        if os.path.exists(target) and os.path.getsize(target) > 0:
            return target
        full = f"{self.origin}{url}"
        full += ("&" if "?" in full else "?") + urllib.parse.urlencode({"t": self.token})
        temporary = target + ".part"
        try:
            with urllib.request.urlopen(full, timeout=60) as response, \
                 open(temporary, "wb") as handle:
                shutil.copyfileobj(response, handle)
            os.replace(temporary, target)
            self.debug(f"cached {url}")
            return target
        except (urllib.error.URLError, OSError) as exc:
            self.log(f"could not fetch {url}: {exc}")
            try:
                os.unlink(temporary)
            except OSError:
                pass
            return None

    # ── playing one item ────────────────────────────────────────────────────

    def play(self, frame):
        """
        Decode one item straight into the card's pipe. Returns False if the
        outer ffmpeg died, which ends the run so the caller can restart it.
        """
        path = None
        if frame is not None and frame.get("url"):
            path = self.asset(frame["url"])
        source = frame if frame is not None else {"kind": "image", "ms": 1000}

        command = [self.ffmpeg, "-hide_banner", "-loglevel", "error"]
        command += input_args(source, path, self.width, self.height, self.fps)
        command += [
            "-an",
            "-vf", f"fps={self.fps:g}," + fit_filter(
                source.get("fit", "contain"), self.width, self.height, self.background
            ),
            "-f", "rawvideo", "-pix_fmt", "uyvy422", "pipe:1",
        ]

        # Worth a line each: when the screen is wrong, the two questions are
        # always "what did it think it was showing" and "did any frame reach
        # the card", and without this the program is silent from the moment the
        # device opens -- which looks identical to a hang.
        self.debug(f"item: {describe_frame(source)}")
        self.debug("inner: " + " ".join(command))

        written = 0
        inner = subprocess.Popen(command, stdout=subprocess.PIPE)
        try:
            while not self.stopping.is_set():
                if self.interrupt.is_set():
                    break
                # EXACTLY one frame, so an interrupt can never leave a partial
                # frame in the pipe and shift everything after it.
                chunk = inner.stdout.read(self.frame_size)
                if not chunk or len(chunk) < self.frame_size:
                    break
                try:
                    self.outer.stdin.write(chunk)
                except (BrokenPipeError, ValueError):
                    return False
                written += 1
                if written == 1:
                    self.debug("first frame reached the card")
        finally:
            self.debug(f"item done after {written} frames")
            inner.kill()
            try:
                inner.stdout.close()
            except OSError:
                pass
            inner.wait(timeout=5)
        return self.outer_alive()

    def frames_now(self):
        """The item list to work through, or [None] meaning 'show black'."""
        with self.plan_lock:
            plan = self.plan
        if not plan:
            return [None]
        # An emergency takeover needs no special case here: the server puts the
        # rendered message in `frames` and forces `power.on`, because this
        # program decodes pictures and video and cannot draw text. If the
        # render failed the frame list is empty and the screen goes black,
        # which is the right answer during an evacuation — better than leaving
        # last week's announcements up.
        if not plan.get("power", {}).get("on", True):
            # Outside the narthex's opening hours. Black in short pieces so a
            # change is picked up quickly rather than at the end of a long one.
            return [None]
        frames = plan.get("frames") or []
        return frames or [None]

    def run(self):
        threading.Thread(target=self.poll_forever, daemon=True).start()

        # Do not start the card until we know what to show, but do not wait
        # forever either: a Mac that boots before the network is up should
        # still come up black rather than not at all.
        deadline = time.time() + 20
        while self.plan is None and time.time() < deadline and not self.stopping.is_set():
            time.sleep(0.5)

        while not self.stopping.is_set():
            if not self.outer_alive():
                if self.outer is not None:
                    self.log("the device closed; reopening in 5s")
                    self.stopping.wait(5)
                    if self.stopping.is_set():
                        break
                self.start_outer()

            self.interrupt.clear()
            for frame in self.frames_now():
                if self.stopping.is_set() or self.interrupt.is_set():
                    break
                if not self.play(frame):
                    break

    def stop(self, *_):
        self.stopping.set()
        self.interrupt.set()
        if self.outer is not None:
            try:
                self.outer.stdin.close()
            except (OSError, ValueError):
                pass
            self.outer.terminate()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True,
                        help="the link from Narthex TV -> Screens -> Copy link")
    parser.add_argument("--device", default="UltraStudio Express Monitor 3G",
                        help="exactly as `ffmpeg -sinks decklink` prints it")
    parser.add_argument("--mode", default="1920x1080@30",
                        help="must be a mode the device supports, e.g. 1920x1080@30")
    parser.add_argument("--ffmpeg", default="~/.local/bin/ffmpeg-decklink",
                        help="the ffmpeg built with --enable-decklink "
                             "(build-ffmpeg-decklink.sh puts it here)")
    parser.add_argument("--cache", default="~/Library/Caches/GRMC/narthex-tv",
                        help="where fetched media is kept")
    parser.add_argument("--background", default="black",
                        help="colour behind anything that does not fill the screen")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    try:
        playout = Playout(args)
    except ValueError as exc:
        # A mistyped URL or mode is a typo, not a crash — say so in one line.
        raise SystemExit(str(exc))
    signal.signal(signal.SIGTERM, playout.stop)
    signal.signal(signal.SIGINT, playout.stop)
    playout.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
