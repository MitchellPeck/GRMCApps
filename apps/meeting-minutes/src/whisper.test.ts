import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasAudioExtension } from "./whisper";

test("hasAudioExtension recognizes common audio containers", () => {
  ["rec.mp3", "clip.m4a", "a.wav", "b.webm", "c.ogg", "d.flac", "e.MP4"].forEach((n) => {
    assert.ok(hasAudioExtension(n), n);
  });
});

test("hasAudioExtension rejects non-audio names", () => {
  ["agenda.pdf", "notes.txt", "image.png", "noext"].forEach((n) => {
    assert.ok(!hasAudioExtension(n), n);
  });
});
