import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { UploadError, appendChunk, recordingPart } from "./pipeline/sermon-files";
import { mergeParts, wavDurationSeconds } from "./pipeline/sermon-transcribe";

test("a recording arrives in order, one piece at a time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sermon-test-"));
  try {
    const size = 10;
    assert.equal(await appendChunk(dir, size, 0, Readable.from([Buffer.from("hello")]), 8), 5);
    await assert.rejects(() => appendChunk(dir, size, 0, Readable.from([Buffer.from("again")]), 8),
      (e: UploadError) => e.status === 409 && e.received === 5, "a repeated piece is told where to carry on");
    await assert.rejects(() => appendChunk(dir, size, 5, Readable.from([Buffer.from("123456789")]), 8),
      (e: UploadError) => e.status === 413);
    await assert.rejects(() => appendChunk(dir, size, 5, Readable.from([Buffer.from("toolong")]), 8),
      (e: UploadError) => e.status === 400);
    assert.equal(await appendChunk(dir, size, 5, Readable.from([Buffer.from("world")]), 8), 10);
    assert.equal((await readFile(recordingPart(dir))).toString(), "helloworld", "a failed piece left nothing behind");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("transcript parts are stitched with each part's real start time", () => {
  const merged = mergeParts([
    { offset: 0, text: " First part. ", segments: [{ start: 0, end: 4.5, text: "First part." }] },
    { offset: 600.2, text: "Second part.", segments: [{ start: 1, end: 3, text: "Second part." }] },
  ]);
  assert.equal(merged.text, "First part.\n\nSecond part.");
  assert.deepEqual(merged.segments.map((s) => [s.start, s.end]), [[0, 4.5], [601.2, 603.2]]);
});

test("a WAV's length comes from its header", () => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(32000 * 90, 40);
  assert.equal(wavDurationSeconds(h), 90);
});
