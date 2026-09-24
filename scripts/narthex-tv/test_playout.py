#!/usr/bin/env python3
"""
Tests for the pure parts of playout.py, plus the pipe mechanics driven by a
stub in place of ffmpeg.

The DeckLink output itself cannot be tested anywhere but in front of the
hardware. What CAN be tested is the part that would ruin the picture silently:
raw video over a pipe has no framing, so if a byte count is ever wrong by less
than one frame, every frame after it is shifted and the screen tears until
somebody restarts it. That invariant is checked here.

    python3 -m unittest discover -s scripts/narthex-tv -p 'test_*.py'
"""

import io
import os
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import playout  # noqa: E402


class PureHelpers(unittest.TestCase):
    def test_parse_mode(self):
        self.assertEqual(playout.parse_mode("1920x1080@30"), (1920, 1080, 30.0))
        self.assertEqual(playout.parse_mode("1280x720@59.94"), (1280, 720, 59.94))
        self.assertEqual(playout.parse_mode("1920x1080"), (1920, 1080, 30.0))
        for bad in ["1080p", "1920x@30", "0x0@30", "1920x1080@0", ""]:
            with self.assertRaises(ValueError, msg=bad):
                playout.parse_mode(bad)

    def test_frame_bytes_is_two_per_pixel(self):
        # uyvy422 is exactly 2 bytes/pixel; this number is the unit everything
        # downstream copies in.
        self.assertEqual(playout.frame_bytes(1920, 1080), 4147200)
        self.assertEqual(playout.frame_bytes(1280, 720), 1843200)

    def test_split_player_url(self):
        origin, token = playout.split_player_url("https://tv.grmc.app/player?t=abc123")
        self.assertEqual(origin, "https://tv.grmc.app")
        self.assertEqual(token, "abc123")
        # ...and the ?token= spelling the API also accepts.
        self.assertEqual(
            playout.split_player_url("https://tv.grmc.app/player?token=xyz")[1], "xyz"
        )

    def test_split_player_url_rejects_a_link_with_no_token(self):
        for bad in ["https://tv.grmc.app/player", "ftp://x/y?t=a", "tv.grmc.app?t=a"]:
            with self.assertRaises(ValueError, msg=bad):
                playout.split_player_url(bad)

    def test_fit_filter_always_lands_on_the_canvas(self):
        contain = playout.fit_filter("contain", 1920, 1080)
        self.assertIn("force_original_aspect_ratio=decrease", contain)
        self.assertIn("pad=1920:1080", contain)

        cover = playout.fit_filter("cover", 1920, 1080)
        self.assertIn("force_original_aspect_ratio=increase", cover)
        self.assertIn("crop=1920:1080", cover)

        # Both must end in the card's only pixel format, or the splice breaks.
        for chain in (contain, cover):
            self.assertIn("format=uyvy422", chain)
            self.assertIn("setsar=1", chain)

    def test_seconds_for(self):
        self.assertEqual(playout.seconds_for({"kind": "image", "ms": 12000}, 10), 12.0)
        # A video with no duration plays to its own end.
        self.assertIsNone(playout.seconds_for({"kind": "video", "ms": None}, 10))
        # An image with no duration falls back rather than running forever.
        self.assertEqual(playout.seconds_for({"kind": "image", "ms": None}, 10), 10)
        # Nothing is ever so short it cannot be shown.
        self.assertEqual(playout.seconds_for({"kind": "image", "ms": 10}, 10), 0.5)

    def test_input_args_per_kind(self):
        image = playout.input_args({"kind": "image", "ms": 12000}, "/m/a.jpg", 1920, 1080, 30)
        self.assertIn("-loop", image)
        self.assertIn("12.000", image)

        video = playout.input_args({"kind": "video", "ms": None}, "/m/a.mp4", 1920, 1080, 30)
        self.assertEqual(video, ["-i", "/m/a.mp4"])

        # A duration on a video is a CAP: -t must come before -i to trim it.
        capped = playout.input_args({"kind": "video", "ms": 5000}, "/m/a.mp4", 1920, 1080, 30)
        self.assertEqual(capped[:2], ["-t", "5.000"])
        self.assertEqual(capped[-2:], ["-i", "/m/a.mp4"])

    def test_a_missing_asset_becomes_black_rather_than_a_dead_pipe(self):
        args = playout.input_args({"kind": "image", "ms": 8000}, None, 1920, 1080, 30)
        self.assertIn("lavfi", args)
        self.assertIn("color=c=black:s=1920x1080:r=30", args)

    def test_cache_name_ignores_the_token(self):
        # The same asset with a reissued token must hit the same cached file.
        a = playout.cache_name("/api/player/media/7/file?t=one")
        b = playout.cache_name("/api/player/media/7/file?t=two")
        self.assertEqual(a, b)
        self.assertNotEqual(a, playout.cache_name("/api/player/media/8/file"))
        self.assertNotIn("/", a)

    def test_ntsc_rates_are_given_exactly(self):
        # The muxer compares the time base against the mode's own for exact
        # equality, so 59.94 -- which is 60000/1001 = 59.94005994... -- matches
        # nothing, and the card answers "Unsupported video size, framerate or
        # field order!". A bars test written as rate=60000/1001 works while the
        # same mode written as 59.94 does not, which is what makes this worth
        # pinning rather than obvious.
        self.assertEqual(playout.rate_arg(59.94), "60000/1001")
        self.assertEqual(playout.rate_arg(29.97), "30000/1001")
        self.assertEqual(playout.rate_arg(23.98), "24000/1001")
        # The whole-number rates really are whole numbers; leave them alone.
        self.assertEqual(playout.rate_arg(30), "30")
        self.assertEqual(playout.rate_arg(60), "60")
        self.assertEqual(playout.rate_arg(25), "25")

    def test_the_default_mode_reaches_ffmpeg_as_a_rational(self):
        # The default is 1080p59.94, so this is the path that actually runs.
        args = playout.build_parser().parse_args(["--url", "http://x/player?t=1"])
        _, _, fps = playout.parse_mode(args.mode)
        command = playout.outer_command("ffmpeg", "Dev", 1920, 1080, fps,
                                        args.format_code)
        self.assertEqual(command[command.index("-r") + 1], "60000/1001")

    def test_outer_command_defaults_to_the_codec_that_works(self):
        # The muxer takes v210 or a wrapped frame, and refuses everything else
        # -- rawvideo included -- at header-write time. But the two it accepts
        # are not equal: wrapped_avframe passes every check and then puts solid
        # red on the screen at a twentieth of real time. Only v210 shows the
        # picture, and nothing in the logs distinguishes them, so pin it.
        command = playout.outer_command("ffmpeg", "UltraStudio Express Monitor 3G",
                                        1920, 1080, 59.94)
        self.assertEqual(command[command.index("-c:v") + 1], "v210")
        # v210 carries its own pixel format; naming another one contradicts it.
        self.assertNotIn("-pix_fmt", command[command.index("-c:v"):])

    def test_the_escape_hatch_codec_still_carries_its_pixel_format(self):
        # wrapped_avframe has no pixel format of its own, so it needs one --
        # the opposite of v210. Kept working for different hardware.
        command = playout.outer_command("ffmpeg", "Dev", 1920, 1080, 30,
                                        codec="wrapped_avframe")
        tail = command[command.index("-c:v"):]
        self.assertEqual(tail[1], "wrapped_avframe")
        self.assertEqual(tail[tail.index("-pix_fmt") + 1], "uyvy422")

    def test_the_command_line_defaults_to_the_mode_that_locks(self):
        # 1080p30 is legal and plenty of televisions mishandle it; 1080p59.94
        # is the one that always locks. The pair must agree.
        args = playout.build_parser().parse_args(["--url", "http://x/player?t=1"])
        self.assertEqual(args.mode, "1920x1080@59.94")
        self.assertEqual(args.format_code, "Hp5994")
        self.assertEqual(args.codec, "v210")

    def test_outer_command_can_name_the_mode_outright(self):
        # -format_code is a muxer option, so it only takes effect if it sits
        # with the output, before -f decklink. Put it after and ffmpeg reads it
        # as an input option and silently ignores it -- which looks exactly
        # like a television that just will not lock.
        command = playout.outer_command("ffmpeg", "Dev", 1920, 1080, 59.94,
                                        format_code="Hp5994")
        self.assertEqual(command[-5:],
                         ["-format_code", "Hp5994", "-f", "decklink", "Dev"])
        # and nothing is added when it is not asked for
        plain = playout.outer_command("ffmpeg", "Dev", 1920, 1080, 30)
        self.assertNotIn("-format_code", plain)

    def test_outer_command_describes_the_pipe_it_is_actually_fed(self):
        # The input half must keep matching what the feeder writes: raw
        # uyvy422 at exactly the mode's size and rate, or every frame is
        # misread.
        command = playout.outer_command("/x/ffmpeg", "Dev", 1280, 720, 59.94)
        self.assertEqual(command[0], "/x/ffmpeg")
        self.assertEqual(command[-3:], ["-f", "decklink", "Dev"])
        self.assertEqual(command[command.index("-i") + 1], "pipe:0")
        self.assertEqual(command[command.index("-s") + 1], "1280x720")
        self.assertEqual(command[command.index("-r") + 1], "60000/1001")
        # The pipe itself is raw; only the output is wrapped.
        self.assertEqual(command[command.index("-f") + 1], "rawvideo")

    def test_describe_frame(self):
        self.assertEqual(playout.describe_frame(None), "black")
        self.assertEqual(
            playout.describe_frame({"kind": "image", "title": "Notice", "ms": 8000}),
            "image Notice (8000 ms)")
        # A video runs to its natural end, which the plan spells as a null.
        self.assertEqual(
            playout.describe_frame({"kind": "video", "title": "Welcome", "ms": None}),
            "video Welcome (to its end)")
        # A slide out of a PowerPoint says which one it is.
        self.assertIn("page 3", playout.describe_frame(
            {"kind": "image", "title": "Deck", "ms": 5000, "page": 3}))

    def test_plan_changed(self):
        first = {"sourceKey": "awake:schedule:1:1:", "revision": "aaa"}
        # Nothing yet: build and start at once.
        self.assertEqual(playout.plan_changed(None, first), (True, True))
        # Same plan: do nothing.
        self.assertEqual(playout.plan_changed(first, dict(first)), (False, False))
        # An edit within the same airing waits for the current item.
        edited = {"sourceKey": first["sourceKey"], "revision": "bbb"}
        self.assertEqual(playout.plan_changed(first, edited), (True, False))
        # A different entry — or the operating hours flipping — cuts in now.
        elsewhere = {"sourceKey": "dark:schedule:1:1:", "revision": "ccc"}
        self.assertEqual(playout.plan_changed(first, elsewhere), (True, True))


# ── the pipe, with a stub standing in for ffmpeg ────────────────────────────

FAKE_FFMPEG = r"""#!/usr/bin/env python3
# Writes FAKE_FRAMES frames of FAKE_FRAME_SIZE bytes, then optionally a partial
# frame, so the copier's alignment can be checked. FAKE_DELAY paces it the way
# the card paces the real thing, which is what makes an interrupt land in the
# middle rather than after everything has already flushed.
import os, sys, time
size = int(os.environ["FAKE_FRAME_SIZE"])
count = int(os.environ["FAKE_FRAMES"])
tail = int(os.environ.get("FAKE_TAIL", "0"))
delay = float(os.environ.get("FAKE_DELAY", "0"))
for i in range(count):
    sys.stdout.buffer.write(bytes([i % 256]) * size)
    if delay:
        sys.stdout.buffer.flush()
        time.sleep(delay)
if tail:
    sys.stdout.buffer.write(b"\xEE" * tail)
sys.stdout.buffer.flush()
"""


def make_args(**overrides):
    """
    Arguments built by the program's own parser, so a flag added to the command
    line cannot quietly go missing here. Every test that needs a Playout goes
    through this.
    """
    argv = ["--url", "http://127.0.0.1:3010/player?t=tok",
            "--device", "Fake", "--mode", "4x4@30"]
    for name, value in overrides.items():
        argv += ["--" + name.replace("_", "-"), str(value)]
    return playout.build_parser().parse_args(argv)


class FakeOuter:
    """
    Stands in for the long-lived ffmpeg that owns the card.

    Backed by a real file rather than a BytesIO, because frames are written to
    the raw descriptor with os.write and selected on -- a stub with no fileno
    would exercise none of that. A regular file is always ready for writing and
    never short-writes, which is the "card keeping up" case; the stall is
    covered separately.
    """

    def __init__(self, path):
        self.stdin = open(path, "wb")
        self.path = path
        self.alive = True
        self.terminated = 0
        self.killed = 0
        self.waited = 0

    def poll(self):
        return None if self.alive else 1

    def terminate(self):
        self.terminated += 1
        self.alive = False

    def kill(self):
        self.killed += 1
        self.alive = False

    def wait(self, timeout=None):
        self.waited += 1
        return 0

    def written(self):
        """Bytes that reached the 'card'."""
        return os.path.getsize(self.path)


class StuckOuter:
    """A card that took the mode and then stopped draining its pipe."""

    def __init__(self, write_fd):
        self.stdin = os.fdopen(write_fd, "wb", buffering=0)
        self.killed = 0
        self.alive = True

    def poll(self):
        return None if self.alive else 1

    def kill(self):
        self.killed += 1
        self.alive = False

    def terminate(self):
        self.kill()

    def wait(self, timeout=None):
        return 0


class PipeMechanics(unittest.TestCase):
    FRAME = 32  # a tiny "frame" keeps the test instant

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.fake = os.path.join(self.tmp, "fake-ffmpeg")
        with open(self.fake, "w") as handle:
            handle.write(FAKE_FFMPEG)
        os.chmod(self.fake, 0o755)

        args = make_args(ffmpeg=self.fake, cache=os.path.join(self.tmp, "cache"))
        self.playout = playout.Playout(args)
        self.playout.frame_size = self.FRAME
        self.playout.outer = FakeOuter(os.path.join(self.tmp, "card"))

    def run_play(self, frames, tail=0, interrupt_after=None, delay=0):
        os.environ["FAKE_FRAME_SIZE"] = str(self.FRAME)
        os.environ["FAKE_FRAMES"] = str(frames)
        os.environ["FAKE_TAIL"] = str(tail)
        os.environ["FAKE_DELAY"] = str(delay)

        if interrupt_after is not None:
            def trip():
                # Let some frames through, then ask for a cut.
                deadline = time.time() + 10
                while (self.playout.outer.written() < interrupt_after * self.FRAME
                       and time.time() < deadline):
                    time.sleep(0.001)
                self.playout.interrupt.set()
            threading.Thread(target=trip, daemon=True).start()

        self.playout.play({"kind": "image", "ms": 1000, "fit": "contain", "url": None})
        return self.playout.outer.written()

    def test_the_signal_handler_never_touches_the_pipe(self):
        # stop() is a signal handler: it runs between two bytecodes of whatever
        # the main thread was doing, which is usually the write in play().
        # Closing the BufferedWriter from there raises "RuntimeError: reentrant
        # call", which kills the interpreter before anything is cleaned up and
        # leaves the ffmpeg holding the card -- after which every later run
        # dies on "Could not enable video output!". So the handler must signal
        # the process and leave the IO alone.
        self.playout.stop()
        self.assertFalse(self.playout.outer.stdin.closed,
                         "stop() closed the pipe it may be interrupting")
        self.assertEqual(self.playout.outer.terminated, 1)
        self.assertTrue(self.playout.stopping.is_set())
        self.assertTrue(self.playout.interrupt.is_set())

    def test_the_card_is_released_on_the_way_out(self):
        # The other half: something still has to close the pipe and reap the
        # process, on the main thread, however the run ended.
        self.playout.close_outer()
        self.assertTrue(self.playout.outer.stdin.closed)
        self.assertGreaterEqual(self.playout.outer.terminated, 1)
        self.assertEqual(self.playout.outer.waited, 1)

    def test_a_write_to_a_terminated_device_ends_the_item_quietly(self):
        # What play() sees once stop() has signalled the outer: the write
        # fails, and that is an expected ending rather than a crash.
        self.playout.outer.stdin.close()
        os.environ["FAKE_FRAME_SIZE"] = str(self.FRAME)
        os.environ["FAKE_FRAMES"] = "3"
        os.environ["FAKE_TAIL"] = "0"
        os.environ["FAKE_DELAY"] = "0"
        self.assertFalse(self.playout.play(
            {"kind": "image", "ms": 1000, "fit": "contain", "url": None}))

    def test_whole_items_are_forwarded_frame_for_frame(self):
        self.assertEqual(self.run_play(frames=5), 5 * self.FRAME)

    def test_a_partial_trailing_frame_is_never_forwarded(self):
        # The single most damaging failure: half a frame in the pipe shifts
        # every frame after it and the picture tears until a restart.
        written = self.run_play(frames=4, tail=self.FRAME // 2)
        self.assertEqual(written, 4 * self.FRAME)
        self.assertEqual(written % self.FRAME, 0)

    def test_an_interrupted_item_still_ends_on_a_frame_boundary(self):
        # Paced like the card paces it, so the cut genuinely lands mid-item.
        written = self.run_play(frames=400, interrupt_after=3, delay=0.005)
        self.assertEqual(written % self.FRAME, 0, "cut mid-frame — the picture would tear")
        self.assertGreater(written, 0)
        self.assertLess(written, 400 * self.FRAME)

    def test_a_card_that_stops_taking_frames_is_given_up_on(self):
        # The real failure this guards. A DeckLink that underruns stops its
        # scheduler and ffmpeg's muxer never restarts it, so the pipe fills and
        # the write never returns. Because the frame loop only tests for an
        # interrupt BETWEEN frames, the whole program stops with it: the screen
        # holds one frame, a new schedule cannot cut in, and an emergency
        # message never arrives.
        #
        # A full pipe with nothing reading it reproduces that exactly.
        read_fd, write_fd = os.pipe()
        stuck = StuckOuter(write_fd)
        self.playout.outer = stuck
        playout.STALL_SECONDS, saved = 0.4, playout.STALL_SECONDS
        try:
            started = time.time()
            ok = self.playout.write_frame(b"\x00" * (1024 * 1024))
            waited = time.time() - started
        finally:
            playout.STALL_SECONDS = saved
            os.close(read_fd)
            try:
                os.close(write_fd)
            except OSError:
                pass

        self.assertFalse(ok, "a stuck card must end the item, not hang")
        self.assertLess(waited, 5, "it waited far past the stall limit")
        self.assertGreaterEqual(waited, 0.4, "it gave up before the limit")
        self.assertEqual(stuck.killed, 1,
                         "a stuck card must be killed so the run loop reopens it")

    def test_a_slow_card_is_not_mistaken_for_a_stuck_one(self):
        # Progress resets the clock: a card taking frames slowly is still
        # working, and restarting it would be the worse answer.
        read_fd, write_fd = os.pipe()
        stuck = StuckOuter(write_fd)
        self.playout.outer = stuck
        playout.STALL_SECONDS, saved = 0.4, playout.STALL_SECONDS

        # A pipe holds 64 KiB, so a 192 KiB frame needs three rounds. Drain
        # generously often enough to finish, at 0.25s between reads -- slower
        # than a frame interval, but never silent for the whole 0.4s limit.
        def drain():
            for _ in range(12):
                time.sleep(0.25)
                try:
                    if not os.read(read_fd, 64 * 1024):
                        return
                except OSError:
                    return
        threading.Thread(target=drain, daemon=True).start()
        try:
            ok = self.playout.write_frame(b"\x00" * (192 * 1024))
        finally:
            playout.STALL_SECONDS = saved
            os.close(read_fd)
            try:
                os.close(write_fd)
            except OSError:
                pass
        self.assertTrue(ok, "a slow but living card was given up on")
        self.assertEqual(stuck.killed, 0)

    def test_a_dead_device_is_reported_rather_than_looping_forever(self):
        self.playout.outer.alive = False
        os.environ.update(FAKE_FRAME_SIZE=str(self.FRAME), FAKE_FRAMES="2", FAKE_TAIL="0")
        ok = self.playout.play({"kind": "image", "ms": 1000, "fit": "contain", "url": None})
        self.assertFalse(ok)


class FrameSelection(unittest.TestCase):
    def make(self, plan):
        # These tests only ask frames_now() what it would play, so any real
        # executable satisfies the startup check without ever being run.
        args = make_args(ffmpeg=sys.executable,
                         cache=os.path.join(tempfile.mkdtemp(), "cache"))
        instance = playout.Playout(args)
        instance.plan = plan
        return instance

    def test_no_plan_yet_shows_black(self):
        self.assertEqual(self.make(None).frames_now(), [None])

    def test_outside_opening_hours_shows_black_whatever_is_scheduled(self):
        instance = self.make({
            "power": {"on": False},
            "frames": [{"kind": "image", "url": "/a", "ms": 1000}],
        })
        self.assertEqual(instance.frames_now(), [None])

    def test_an_empty_playlist_shows_black(self):
        instance = self.make({"power": {"on": True}, "frames": []})
        self.assertEqual(instance.frames_now(), [None])

    def test_frames_are_played_in_order(self):
        frames = [{"kind": "image", "url": "/a"}, {"kind": "video", "url": "/b"}]
        instance = self.make({"power": {"on": True}, "frames": frames})
        self.assertEqual(instance.frames_now(), frames)

    def test_a_plan_with_no_power_block_is_treated_as_awake(self):
        # Defensive: an older server, or a cached plan from before the
        # operating-hours feature, must not black the screen out.
        frames = [{"kind": "image", "url": "/a"}]
        instance = self.make({"frames": frames})
        self.assertEqual(instance.frames_now(), frames)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TakeoverHandling(unittest.TestCase):
    """An emergency needs no special case in the frame loop — the server puts
    the rendered message in `frames` and forces power.on — but it must not be
    hidden by the operating hours, and it must be reported."""

    def make(self, plan):
        # These tests only ask frames_now() what it would play, so any real
        # executable satisfies the startup check without ever being run.
        args = make_args(ffmpeg=sys.executable,
                         cache=os.path.join(tempfile.mkdtemp(), "cache"))
        instance = playout.Playout(args)
        instance.plan = plan
        return instance

    def test_an_emergency_outside_hours_is_still_shown(self):
        frame = {"kind": "image", "url": "/api/player/takeover/123.jpg", "ms": 30000}
        # The server forces power.on for a takeover; this asserts we honour it
        # rather than blacking the screen out on the hours.
        instance = self.make({
            "power": {"on": True},
            "takeover": {"active": True, "headline": "EVACUATE"},
            "frames": [frame],
        })
        self.assertEqual(instance.frames_now(), [frame])

    def test_an_emergency_that_failed_to_render_goes_black_not_stale(self):
        # Better a black screen during an evacuation than last week's notices.
        instance = self.make({
            "power": {"on": True},
            "takeover": {"active": True, "headline": "EVACUATE"},
            "frames": [],
        })
        self.assertEqual(instance.frames_now(), [None])

    def test_takeover_active_reads_the_plan_defensively(self):
        self.assertFalse(playout.Playout.takeover_active(None))
        self.assertFalse(playout.Playout.takeover_active({}))
        self.assertFalse(playout.Playout.takeover_active({"takeover": {"active": False}}))
        self.assertTrue(playout.Playout.takeover_active({"takeover": {"active": True}}))
