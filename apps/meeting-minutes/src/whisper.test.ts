import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasAudioExtension, parseVerboseJson } from "./whisper";

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

test("parseVerboseJson extracts diarized segments", () => {
  const raw = JSON.stringify({
    text: "We should launch next week. I think QA needs two more days.",
    segments: [
      { id: 0, start: 1.0, end: 3.5, text: " We should launch next week.", speaker: "SPEAKER_00" },
      { id: 1, start: 4.0, end: 6.2, text: "I think QA needs two more days.", speaker: "SPEAKER_01" },
    ],
  });
  const r = parseVerboseJson(raw);
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].speaker, "SPEAKER_00");
  assert.equal(r.segments[0].text, "We should launch next week."); // trimmed
  assert.match(r.text, /launch next week/);
});

test("parseVerboseJson tolerates missing speakers and empty segments", () => {
  const r = parseVerboseJson(JSON.stringify({ text: "hi", segments: [{ text: "hi" }, { text: "  " }] }));
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].speaker, "");
});

test("parseVerboseJson falls back to plain text on non-JSON", () => {
  const r = parseVerboseJson("just plain text");
  assert.equal(r.text, "just plain text");
  assert.deepEqual(r.segments, []);
});
