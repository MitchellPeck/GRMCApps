import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatClock, formatRangeMarker, parseClock, segmentsRange, splitRangeMarker, stripRangeMarkers } from "./ranges";

test("range markers round-trip and strip", () => {
  const r = { source: "m" as const, recordingId: 12, start: 742, end: 1450.46 };
  assert.equal(formatRangeMarker(r), "<!--t:m12:742.0-1450.5-->");
  assert.deepEqual(splitRangeMarker("### 3. Budget <!--t:m12:742.0-1450.5-->"),
    { text: "### 3. Budget", range: { source: "m", recordingId: 12, start: 742, end: 1450.5 } });
  assert.deepEqual(splitRangeMarker("### 3. Budget"), { text: "### 3. Budget", range: null });
  // Only a marker at the end of the line counts.
  assert.deepEqual(splitRangeMarker("a <!--t:m1:0.0-1.0--> b"), { text: "a <!--t:m1:0.0-1.0--> b", range: null });
  assert.equal(stripRangeMarkers("a <!--t:i4:1.0-2.0-->\nb"), "a\nb");
});

test("parseClock and formatClock", () => {
  assert.equal(parseClock("12:40"), 760);
  assert.equal(parseClock("1:02:05"), 3725);
  assert.equal(parseClock("soon"), null);
  assert.equal(parseClock("12:75"), null);
  assert.equal(formatClock(760), "12:40");
  assert.equal(formatClock(5), "0:05");
  assert.equal(formatClock(3725), "1:02:05");
});

test("segmentsRange spans the segments, null when empty", () => {
  const segs = [{ text: "a", speaker: "S0", start: 30, end: 40 }, { text: "b", speaker: "S1", start: 10, end: 20 }];
  assert.deepEqual(segmentsRange(segs, "i", 4), { source: "i", recordingId: 4, start: 10, end: 40 });
  assert.equal(segmentsRange([], "m", 1), null);
});
