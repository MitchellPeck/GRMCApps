import { strict as assert } from "node:assert";
import { test } from "node:test";
import { displayCode, fmtAmount, fmtDate, heuristicSummary } from "./format";

test("fmtAmount renders US currency and handles negatives and blanks", () => {
  assert.equal(fmtAmount(85), "$85.00");
  assert.equal(fmtAmount(-8.87), "-$8.87");   // the Free Shipping Promo case
  assert.equal(fmtAmount(0), "$0.00");
  assert.equal(fmtAmount(NaN), "$0.00");
  assert.equal(fmtAmount("16.41" as unknown as number), "$16.41");
});

test("fmtDate formats an ISO date without timezone drift", () => {
  // Parsing "2026-09-17" as UTC then rendering locally rolls back a day west
  // of UTC, which would silently date every expense request wrong.
  assert.equal(fmtDate("2026-09-17"), "September 17, 2026");
  assert.equal(fmtDate("2026-01-01"), "January 1, 2026");
  assert.equal(fmtDate(""), "—");
});

test("heuristicSummary lists three titles then counts the rest", () => {
  assert.equal(heuristicSummary([]), "");
  assert.equal(heuristicSummary(["A", "B"]), "A, B");
  assert.equal(heuristicSummary(["A", "B", "C", "D", "E"]), "A, B, C +2 more");
});

test("heuristicSummary elides a long title rather than letting it run", () => {
  const long = "x".repeat(60);
  const out = heuristicSummary([long]);
  assert.equal(out.length <= 41, true);
  assert.equal(out.endsWith("…"), true);
});

test("displayCode shows code and label together, or just the code if unknown", () => {
  const tree = [{ id: 1, code: "5540", label: "Audio/Video Streaming", subs: [] }];
  assert.equal(displayCode("5540", tree), "5540 — Audio/Video Streaming");
  assert.equal(displayCode("9999", tree), "9999");
  assert.equal(displayCode("", tree), "—");
});
