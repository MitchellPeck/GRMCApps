import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySpeakerClusters, clusterFingerprints, labelAudio, wavSamples } from "./speakerLinking";
import { transcribeLongAudio } from "./chunking";
import { DiarizedSegment } from "./whisper";

const v = (...xs: number[]) => Float32Array.from(xs);

test("similar voices merge, different voices stay apart", () => {
  const out = clusterFingerprints([
    { key: "P1_SPEAKER_00", embedding: v(1, 0, 0) },
    { key: "P2_SPEAKER_03", embedding: v(0.95, 0.1, 0) },
    { key: "P1_SPEAKER_01", embedding: v(0, 1, 0) },
    { key: "P3_SPEAKER_00", embedding: v(0.05, 0.98, 0) },
  ], undefined);
  assert.equal(out.get("P1_SPEAKER_00"), out.get("P2_SPEAKER_03"));
  assert.equal(out.get("P1_SPEAKER_01"), out.get("P3_SPEAKER_00"));
  assert.notEqual(out.get("P1_SPEAKER_00"), out.get("P1_SPEAKER_01"));
});

// The regression: 8 people, 200+ speakers. However many labels come in,
// never report more voices than the people present.
test("never reports more voices than people present", () => {
  const prints = Array.from({ length: 210 }, (_, i) => {
    const e = new Float32Array(64);
    e[i % 64] = 1; // 64 mutually dissimilar "voices"
    return { key: `P${1 + Math.floor(i / 30)}_SPEAKER_${i % 30}`, embedding: e };
  });
  const out = clusterFingerprints(prints, 8);
  assert.equal(new Set(out.values()).size, 8);
  assert.equal(out.size, 210);
});

test("labels are renumbered meeting-wide; short labels follow the nearest turn", () => {
  const segs: DiarizedSegment[] = [
    { text: "a", speaker: "P1_SPEAKER_01", start: 0, end: 5 },
    { text: "b", speaker: "P1_SPEAKER_00", start: 5, end: 9 },
    { text: "c", speaker: "P1_SPEAKER_07", start: 9, end: 9.5 }, // too short to fingerprint
    { text: "d", speaker: "", start: 10, end: 11 },
    { text: "e", speaker: "P2_SPEAKER_00", start: 600, end: 605 },
  ];
  const clusters = new Map([["P1_SPEAKER_01", 4], ["P1_SPEAKER_00", 2], ["P2_SPEAKER_00", 4]]);
  assert.deepEqual(applySpeakerClusters(segs, clusters).map((s) => s.speaker),
    ["SPEAKER_00", "SPEAKER_01", "SPEAKER_01", "", "SPEAKER_00"]);
});

test("labelAudio takes the label's own turns, longest first, capped", () => {
  const rate = 10;
  const samples = Float32Array.from({ length: 100 }, (_, i) => i);
  const segs: DiarizedSegment[] = [
    { text: "", speaker: "A", start: 0, end: 1 },
    { text: "", speaker: "B", start: 1, end: 2 },
    { text: "", speaker: "A", start: 5, end: 8 },
  ];
  assert.deepEqual(Array.from(labelAudio(samples, rate, segs, "A")),
    [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

// ── Real voices, real model ─────────────────────────────────────────────────
// Needs ffmpeg, espeak-ng, the sherpa-onnx addon and the speaker model
// (SPEAKER_EMBEDDING_MODEL, or the image's /app/models path). Skips otherwise.

const modelPath = process.env.SPEAKER_EMBEDDING_MODEL || "/app/models/speaker-embedding.onnx";
let sherpaOk = false;
try { require.resolve("sherpa-onnx-node"); sherpaOk = true; } catch { /* not installed */ }
const tools = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("espeak-ng", ["--version"]).status === 0;
const skipReal = !(tools && sherpaOk && existsSync(modelPath));

test("three voices across three parts come back as three speakers", { skip: skipReal }, async () => {
  const { embedSpeaker } = await import("./speakerEmbedding");
  const dir = mkdtempSync(join(tmpdir(), "voices-"));
  try {
    // ~25 minutes of three synthetic voices taking turns, 1.5 s pause after each.
    const voices = ["en-us", "en-us+f3", "en-gb-x-rp+m7"];
    const text = "Thank you. Moving on to the next item on the agenda, the finance committee reviewed the budget and recommends approval.";
    const clipSeconds: number[] = [];
    voices.forEach((voice, i) => {
      assert.equal(spawnSync("espeak-ng", ["-v", voice, "-s", "140", "-w", join(dir, `raw${i}.wav`), text]).status, 0);
      assert.equal(spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", join(dir, `raw${i}.wav`),
        "-af", "apad=pad_dur=1.5", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", join(dir, `v${i}.wav`)]).status, 0);
      clipSeconds.push(wavSamples(readFileSync(join(dir, `v${i}.wav`))).samples.length / 16000);
    });
    const turns: { voice: number; start: number; end: number }[] = [];
    const files: string[] = [];
    for (let t = 0, k = 0; t < 1500; k++) {
      const voice = k % 3;
      files.push(`file '${join(dir, `v${voice}.wav`)}'`);
      turns.push({ voice, start: t, end: t + clipSeconds[voice] - 1.5 });
      t += clipSeconds[voice];
    }
    writeFileSync(join(dir, "list.txt"), files.join("\n"));
    const meeting = join(dir, "meeting.webm");
    assert.equal(spawnSync("ffmpeg", ["-loglevel", "error", "-f", "concat", "-safe", "0",
      "-i", join(dir, "list.txt"), "-c:a", "libopus", meeting]).status, 0);

    // Fake whisper: perfect turns, but labels that mean a different voice in
    // every part — exactly the inconsistency real per-part diarization has.
    let partStart = 0, part = 0;
    const result = await transcribeLongAudio(meeting, 600, {
      transcribe: async (file) => {
        const dur = wavSamples(file.buffer).samples.length / 16000;
        const segments: DiarizedSegment[] = turns
          .filter((u) => (u.start + u.end) / 2 >= partStart && (u.start + u.end) / 2 < partStart + dur)
          .map((u) => ({
            text: `voice${u.voice}`,
            speaker: `SPEAKER_0${(u.voice + part) % 3}`,
            start: Math.max(0, u.start - partStart),
            end: Math.min(dur, u.end - partStart),
          }));
        partStart += dur; part++;
        return { text: "", segments };
      },
      embed: embedSpeaker,
      log: () => {},
    }, { maxSpeakers: 8 });

    assert.ok(part >= 3, `expected at least 3 parts, got ${part}`);
    const speakerOf = new Map<string, Set<string>>();
    for (const s of result.segments) {
      if (!speakerOf.has(s.text)) speakerOf.set(s.text, new Set());
      speakerOf.get(s.text)!.add(s.speaker);
    }
    for (const [voice, labels] of speakerOf) assert.equal(labels.size, 1, `${voice} split across ${[...labels]}`);
    assert.equal(new Set(result.segments.map((s) => s.speaker)).size, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
