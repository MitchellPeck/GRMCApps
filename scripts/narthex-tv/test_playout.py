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


class FakeOuter:
    """Stands in for the long-lived ffmpeg that owns the card."""

    def __init__(self):
        self.stdin = io.BytesIO()
        self.alive = True

    def poll(self):
        return None if self.alive else 1


class PipeMechanics(unittest.TestCase):
    FRAME = 32  # a tiny "frame" keeps the test instant

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.fake = os.path.join(self.tmp, "fake-ffmpeg")
        with open(self.fake, "w") as handle:
            handle.write(FAKE_FFMPEG)
        os.chmod(self.fake, 0o755)

        args = types.SimpleNamespace(
            url="https://tv.grmc.app/player?t=tok",
            device="Fake", mode="4x4@30", ffmpeg=self.fake,
            cache=os.path.join(self.tmp, "cache"), background="black", verbose=False,
        )
        self.playout = playout.Playout(args)
        self.playout.frame_size = self.FRAME
        self.playout.outer = FakeOuter()

    def run_play(self, frames, tail=0, interrupt_after=None, delay=0):
        os.environ["FAKE_FRAME_SIZE"] = str(self.FRAME)
        os.environ["FAKE_FRAMES"] = str(frames)
        os.environ["FAKE_TAIL"] = str(tail)
        os.environ["FAKE_DELAY"] = str(delay)

        if interrupt_after is not None:
            def trip():
                # Let some frames through, then ask for a cut.
                deadline = time.time() + 10
                while (self.playout.outer.stdin.tell() < interrupt_after * self.FRAME
                       and time.time() < deadline):
                    time.sleep(0.001)
                self.playout.interrupt.set()
            threading.Thread(target=trip, daemon=True).start()

        self.playout.play({"kind": "image", "ms": 1000, "fit": "contain", "url": None})
        return self.playout.outer.stdin.tell()

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

    def test_a_dead_device_is_reported_rather_than_looping_forever(self):
        self.playout.outer.alive = False
        os.environ.update(FAKE_FRAME_SIZE=str(self.FRAME), FAKE_FRAMES="2", FAKE_TAIL="0")
        ok = self.playout.play({"kind": "image", "ms": 1000, "fit": "contain", "url": None})
        self.assertFalse(ok)


class FrameSelection(unittest.TestCase):
    def make(self, plan):
        args = types.SimpleNamespace(
            url="https://tv.grmc.app/player?t=tok", device="Fake", mode="4x4@30",
            ffmpeg="true", cache=tempfile.mkdtemp(), background="black", verbose=False,
        )
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
        args = types.SimpleNamespace(
            url="https://tv.grmc.app/player?t=tok", device="Fake", mode="4x4@30",
            ffmpeg="true", cache=tempfile.mkdtemp(), background="black", verbose=False,
        )
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
