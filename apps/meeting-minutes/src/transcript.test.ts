import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderTranscript, distinctSpeakers, friendlyLabel } from "./transcript";
import { DiarizedSegment } from "./whisper";

const seg = (text: string, speaker: string): DiarizedSegment => ({ text, speaker, start: 0, end: 0 });

test("distinctSpeakers preserves first-appearance order", () => {
  const segs = [seg("a", "SPEAKER_01"), seg("b", "SPEAKER_00"), seg("c", "SPEAKER_01")];
  assert.deepEqual(distinctSpeakers(segs), ["SPEAKER_01", "SPEAKER_00"]);
});

test("friendlyLabel numbers by appearance order", () => {
  const order = ["SPEAKER_01", "SPEAKER_00"];
  assert.equal(friendlyLabel("SPEAKER_01", order), "Speaker 1");
  assert.equal(friendlyLabel("SPEAKER_00", order), "Speaker 2");
});

test("renderTranscript merges consecutive same-speaker segments and uses names", () => {
  const segs = [
    seg("Hello everyone.", "SPEAKER_00"),
    seg("Let's begin.", "SPEAKER_00"),
    seg("Sounds good.", "SPEAKER_01"),
    seg("One more thing.", "SPEAKER_00"),
  ];
  const out = renderTranscript(segs, { SPEAKER_00: "Alice", SPEAKER_01: "Bob" });
  assert.equal(out, "Alice: Hello everyone. Let's begin.\nBob: Sounds good.\nAlice: One more thing.");
});

test("renderTranscript falls back to Speaker N for unmapped speakers", () => {
  const segs = [seg("Hi.", "SPEAKER_00"), seg("Yo.", "SPEAKER_01")];
  const out = renderTranscript(segs, { SPEAKER_00: "Alice" });
  assert.equal(out, "Alice: Hi.\nSpeaker 2: Yo.");
});

test("renderTranscript with no speaker labels returns plain joined text", () => {
  const segs = [seg("one", ""), seg("two", "")];
  assert.equal(renderTranscript(segs, {}), "one two");
});

test("renderTranscript empty for no segments", () => {
  assert.equal(renderTranscript([], {}), "");
});
