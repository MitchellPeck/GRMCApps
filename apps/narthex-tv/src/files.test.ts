import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "./files";

test("parseRange reads an ordinary range", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
});

test("parseRange reads a suffix range", () => {
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("parseRange clamps an end past the file", () => {
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 });
});

test("parseRange declines anything it cannot honour, so the whole file is sent", () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange("bytes=1000-", 1000), null); // start past the end
  assert.equal(parseRange("bytes=-", 1000), null);
  assert.equal(parseRange("items=0-10", 1000), null);
  assert.equal(parseRange("bytes=0-99,200-299", 1000), null); // multi-range
  assert.equal(parseRange("bytes=0-99", 0), null);
});
