import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildTurns, absorbMicroTurns } from "./speakers";
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
