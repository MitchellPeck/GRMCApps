import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseCutPoints, mergePartResults, parseSilences, splitAudio, transcribeLongAudio, wavDurationSeconds,
} from "./chunking";
import { segmentByMarkers } from "./segmentation";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("parseSilences pairs starts with ends", () => {
  const log = [
    "[silencedetect @ 0x1] silence_start: 5.2",
    "[silencedetect @ 0x1] silence_end: 6.1 | silence_duration: 0.9",
    "[silencedetect @ 0x1] silence_start: -0.01",
    "[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.51",
    "[silencedetect @ 0x1] silence_start: 99", // unterminated at EOF: ignored
  ].join("\n");
  assert.deepEqual(parseSilences(log), [{ start: 5.2, end: 6.1 }, { start: 0, end: 0.5 }]);
});

test("cuts snap to the nearest pause within the window, else the target", () => {
  const silences = [{ start: 590, end: 592 }, { start: 640, end: 641 }, { start: 1250, end: 1251 }];
  // 600 → pause at 591; 1200 → no pause within 30s of it (1250 is 50s away).
  assert.deepEqual(chooseCutPoints(1800, silences, 600), [591, 1200]);
});

test("a short recording is not cut, and no tiny last part is left", () => {
  assert.deepEqual(chooseCutPoints(300, [], 600), []);
  assert.deepEqual(chooseCutPoints(630, [], 600), []); // 30s tail would be too short
  assert.deepEqual(chooseCutPoints(4200, [], 600), [600, 1200, 1800, 2400, 3000, 3600]); // 70 min
});

test("a single part keeps its labels and timings untouched", () => {
  const result = { text: "hi", segments: [{ text: "hi", speaker: "SPEAKER_00", start: 1, end: 2 }] };
  assert.equal(mergePartResults([{ offset: 0, result }]), result);
});

test("parts are shifted onto the recording's timeline with per-part speaker labels", () => {
  const merged = mergePartResults([
    { offset: 0, result: { text: "a", segments: [{ text: "a", speaker: "SPEAKER_00", start: 1, end: 2 }] } },
    { offset: 598.5, result: { text: "b", segments: [
      { text: "b", speaker: "SPEAKER_00", start: 3, end: 4 },
      { text: "c", speaker: "", start: 5, end: 6 },
    ] } },
  ]);
  assert.deepEqual(merged.segments, [
    { text: "a", speaker: "P1_SPEAKER_00", start: 1, end: 2 },
    { text: "b", speaker: "P2_SPEAKER_00", start: 601.5, end: 602.5 },
    { text: "c", speaker: "", start: 603.5, end: 604.5 },
  ]);
  assert.equal(merged.text, "a b");
});

// The topic markers recorded during the meeting are seconds from the start of
// the recording. Because parts are shifted back onto that timeline, they file
// text under the right topic without any change to the stored markers.
test("topic markers still file text under the right topic after splitting", () => {
  const merged = mergePartResults([
    { offset: 0, result: { text: "", segments: [{ text: "budget talk", speaker: "SPEAKER_00", start: 100, end: 110 }] } },
    { offset: 600, result: { text: "", segments: [
      { text: "more budget", speaker: "SPEAKER_01", start: 10, end: 20 },   // 610–620
      { text: "roof repairs", speaker: "SPEAKER_01", start: 200, end: 210 }, // 800–810
    ] } },
  ]);
  const byItem = segmentByMarkers(merged.segments, [{ itemId: 1, atSeconds: 0 }, { itemId: 2, atSeconds: 700 }], 1);
  assert.deepEqual(byItem.get(1)!.map((s) => s.text), ["budget talk", "more budget"]);
  assert.deepEqual(byItem.get(2)!.map((s) => s.text), ["roof repairs"]);
});

test("wavDurationSeconds reads the data chunk", () => {
  const rate = 16000, seconds = 2, data = rate * 2 * seconds;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + data, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(data, 40);
  assert.equal(wavDurationSeconds(buf), 2);
  assert.throws(() => wavDurationSeconds(Buffer.from("not a wav")));
});

// ── Real ffmpeg ─────────────────────────────────────────────────────────────

// 25 minutes of opus-in-webm (what the browser records): a tone that pauses
// for one second in every seven, so there are pauses to cut at.
function makeRecording(dir: string): string {
  const out = join(dir, "meeting.webm");
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1500:sample_rate=48000",
    "-af", "volume='if(lt(mod(t,7),6),1,0)':eval=frame", "-c:a", "libopus", "-b:a", "16k", out,
  ]);
  assert.equal(r.status, 0, r.stderr?.toString());
  return out;
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

test("splits a real recording at pauses into parts that add up to the whole", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "chunk-test-"));
  try {
    const input = makeRecording(dir);
    const work = mkdtempSync(join(dir, "work-"));
    const parts = await splitAudio(input, work, 600);
    assert.equal(parts.length, 3);
    assert.equal(parts[0].offset, 0);
    const lengths = parts.map((p) => wavDurationSeconds(readFileSync(p.path)));
    assert.ok(Math.abs(lengths.reduce((a, b) => a + b, 0) - 1500) < 0.5, `total ${lengths}`);
    // Each cut landed inside a pause (the silent second is t mod 7 in [6,7)).
    for (const p of parts.slice(1)) {
      const phase = p.offset % 7;
      assert.ok(phase >= 5.9 && phase <= 7.1, `cut at ${p.offset} is not in a pause`);
      assert.ok(Math.abs(p.offset - 600 * parts.indexOf(p)) <= 30);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribing in parts never modifies the stored recording and cleans up", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "chunk-test-"));
  try {
    const input = makeRecording(dir);
    const before = sha(input);
    const tmpBefore = readdirSync(tmpdir()).filter((n) => n.startsWith("minutes-split-")).length;
    const sent: number[] = [];
    const result = await transcribeLongAudio(input, 600, {
      transcribe: async (file) => {
        sent.push(file.buffer.length);
        assert.equal(file.mimeType, "audio/wav");
        return { text: "x", segments: [{ text: "x", speaker: "SPEAKER_00", start: 1, end: 4 }] };
      },
      // One steady tone throughout: every part's label is the same "voice".
      embed: () => Float32Array.from([1, 0, 0]),
      log: () => {},
    }, { maxSpeakers: 8 });
    assert.equal(sent.length, 3);
    // Matched across parts to one meeting-wide speaker, not one per part.
    assert.deepEqual(result.segments.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00"]);
    assert.equal(result.segments[0].start, 1);
    assert.ok(result.segments[1].start > 570 && result.segments[1].start < 632);
    assert.equal(sha(input), before, "the stored recording is untouched");
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith("minutes-split-")).length, tmpBefore);

    // A failing part fails the job with which part it was — and still leaves
    // the recording intact for a retry.
    await assert.rejects(
      transcribeLongAudio(input, 600, {
        transcribe: async () => { if (sent.length++ >= 4) throw new Error("socket hang up"); return { text: "", segments: [] }; },
        embed: () => Float32Array.from([1]),
        log: () => {},
      }),
      /Part 2 of 3: socket hang up/
    );
    assert.equal(sha(input), before);
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith("minutes-split-")).length, tmpBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing ffmpeg-readable file fails clearly", { skip: !hasFfmpeg }, async () => {
  await assert.rejects(
    transcribeLongAudio("/nonexistent/recording.webm", 600, { transcribe: async () => ({ text: "", segments: [] }), log: () => {} }),
    /Could not read the recording audio/
  );
});

test("a split recording without speaker matching fails instead of saving phantom speakers", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "chunk-test-"));
  try {
    const input = makeRecording(dir);
    await assert.rejects(
      transcribeLongAudio(input, 600, { transcribe: async () => ({ text: "", segments: [] }), log: () => {} }),
      /Speaker matching is unavailable/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
