import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildTurns, absorbMicroTurns, speakerStats, dominantSpeaker, assignPresenterToDominant,
} from "./speakers";
import { DiarizedSegment } from "./whisper";

const seg = (text: string, speaker: string, start: number, end: number): DiarizedSegment =>
  ({ text, speaker, start, end });

test("buildTurns groups consecutive segments sharing a speaker", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 1),
    seg("b", "SPEAKER_00", 1, 2),
    seg("c", "SPEAKER_01", 2, 3),
  ];
  const turns = buildTurns(segs);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], { speaker: "SPEAKER_00", start: 0, end: 2, indexes: [0, 1] });
  assert.deepEqual(turns[1], { speaker: "SPEAKER_01", start: 2, end: 3, indexes: [2] });
});

test("absorbMicroTurns reassigns a short sandwiched turn to its neighbours", () => {
  const segs = [
    seg("So the budget for the year", "SPEAKER_00", 0, 4),
    seg("is about", "SPEAKER_01", 4, 4.6),
    seg("twelve thousand dollars.", "SPEAKER_00", 4.6, 8),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00"]);
});

test("absorbMicroTurns leaves a genuinely long sandwiched turn alone", () => {
  const segs = [
    seg("What do you think?", "SPEAKER_00", 0, 2),
    seg("I think we should wait until the next quarter before committing.", "SPEAKER_01", 2, 8),
    seg("Fair enough.", "SPEAKER_00", 8, 9),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"]);
});

test("absorbMicroTurns leaves a short turn between two DIFFERENT speakers alone", () => {
  const segs = [
    seg("Ready?", "SPEAKER_00", 0, 1),
    seg("Yes.", "SPEAKER_01", 1, 1.4),
    seg("Then let's go.", "SPEAKER_02", 1.4, 3),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_01", "SPEAKER_02"]);
});

test("absorbMicroTurns leaves leading and trailing short turns alone", () => {
  const segs = [
    seg("Uh.", "SPEAKER_01", 0, 0.4),
    seg("Welcome everyone to the meeting.", "SPEAKER_00", 0.4, 5),
    seg("Mm.", "SPEAKER_01", 5, 5.3),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_01", "SPEAKER_00", "SPEAKER_01"]);
});

test("absorbMicroTurns collapses repeated flips within one sentence", () => {
  const segs = [
    seg("We need", "SPEAKER_00", 0, 0.8),
    seg("to book", "SPEAKER_01", 0.8, 1.4),
    seg("the hall", "SPEAKER_00", 1.4, 2.0),
    seg("for June.", "SPEAKER_01", 2.0, 2.6),
    seg("Agreed, I will call them tomorrow morning.", "SPEAKER_00", 2.6, 8),
  ];
  const out = absorbMicroTurns(segs);
  assert.deepEqual(out.map((s) => s.speaker),
    ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00", "SPEAKER_00", "SPEAKER_00"]);
});

test("absorbMicroTurns does not mutate its input", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 4),
    seg("b", "SPEAKER_01", 4, 4.5),
    seg("c", "SPEAKER_00", 4.5, 8),
  ];
  absorbMicroTurns(segs);
  assert.equal(segs[1].speaker, "SPEAKER_01");
});

test("absorbMicroTurns handles empty and single-segment input", () => {
  assert.deepEqual(absorbMicroTurns([]), []);
  const one = [seg("a", "SPEAKER_00", 0, 1)];
  assert.deepEqual(absorbMicroTurns(one).map((s) => s.speaker), ["SPEAKER_00"]);
});

test("absorbMicroTurns resolves adjacent ambiguous short turns leftmost-first", () => {
  // When two adjacent short turns are both eligible (sandwiched between
  // same-speaker neighbors), the leftmost wins — a deliberate tie-break.
  // Later reconciliation passes handle residual ambiguity.
  const segs = [
    seg("Long intro from speaker zero", "SPEAKER_00", 0, 4),
    seg("uh", "SPEAKER_01", 4, 4.5),
    seg("hmm", "SPEAKER_00", 4.5, 5.4),
    seg("Long outro from speaker one", "SPEAKER_01", 5.4, 9),
  ];
  const out = absorbMicroTurns(segs);
  // Leftmost (SPEAKER_01 at index 1) is absorbed first → SPEAKER_00.
  // After rescan, SPEAKER_00 at index 2 is now adjacent to SPEAKER_00 at index 0,
  // so it doesn't qualify (cur.speaker === prev.speaker). Result: all SPEAKER_00.
  assert.deepEqual(out.map((s) => s.speaker), ["SPEAKER_00", "SPEAKER_00", "SPEAKER_00", "SPEAKER_01"]);
});

test("speakerStats ranks by talk time and keeps first-appearance labels", () => {
  const segs = [
    seg("Short opener.", "SPEAKER_00", 0, 2),
    seg("A much longer explanation of the budget position.", "SPEAKER_01", 2, 12),
    seg("Right.", "SPEAKER_00", 12, 13),
  ];
  const stats = speakerStats(segs);
  assert.equal(stats.length, 2);
  assert.equal(stats[0].speaker, "SPEAKER_01");
  assert.equal(stats[0].label, "Speaker 2");   // second to appear
  assert.equal(stats[0].seconds, 10);
  assert.equal(stats[1].speaker, "SPEAKER_00");
  assert.equal(stats[1].label, "Speaker 1");
  assert.equal(stats[1].seconds, 3);
  assert.equal(Math.round(stats[0].share * 100), 77);
  assert.equal(stats[0].sample, "A much longer explanation of the budget position.");
});

test("speakerStats ignores unlabelled segments and returns empty for none", () => {
  assert.deepEqual(speakerStats([]), []);
  assert.deepEqual(speakerStats([seg("hi", "", 0, 1)]), []);
});

test("speakerStats truncates a long sample quote", () => {
  const long = "x".repeat(200);
  const stats = speakerStats([seg(long, "SPEAKER_00", 0, 5)]);
  assert.equal(stats[0].sample.length, 81); // 80 chars + the single "…" character
  assert.ok(stats[0].sample.endsWith("…"));
});

test("dominantSpeaker picks the label with the most total speaking time", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 2),
    seg("b", "SPEAKER_01", 2, 3),
    seg("c", "SPEAKER_01", 3, 4),
    seg("d", "SPEAKER_00", 4, 9),
  ];
  assert.equal(dominantSpeaker(segs), "SPEAKER_00");
  assert.equal(dominantSpeaker([]), "");
});

test("assignPresenterToDominant maps the busiest voice to the presenter", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 10),
    seg("b", "SPEAKER_01", 10, 12),
  ];
  assert.deepEqual(assignPresenterToDominant(segs, {}, "Alice Smith"), { SPEAKER_00: "Alice Smith" });
});

test("assignPresenterToDominant is a no-op when the presenter already has a voice", () => {
  const segs = [
    seg("a", "SPEAKER_00", 0, 10),
    seg("b", "SPEAKER_01", 10, 12),
  ];
  const map = { SPEAKER_01: "alice smith" };
  assert.deepEqual(assignPresenterToDominant(segs, map, "Alice Smith"), map);
});

test("assignPresenterToDominant never overwrites an existing name on the busiest voice", () => {
  const segs = [seg("a", "SPEAKER_00", 0, 10), seg("b", "SPEAKER_01", 10, 12)];
  const map = { SPEAKER_00: "Bob Jones" };
  assert.deepEqual(assignPresenterToDominant(segs, map, "Alice Smith"), map);
});

test("assignPresenterToDominant is a no-op without a presenter or segments", () => {
  const segs = [seg("a", "SPEAKER_00", 0, 10)];
  assert.deepEqual(assignPresenterToDominant(segs, {}, "  "), {});
  assert.deepEqual(assignPresenterToDominant([], {}, "Alice Smith"), {});
});
