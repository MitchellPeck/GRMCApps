import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, localDateKey, parseHM, tzOffsetMs, weekdayOf, zonedParts, zonedTimeToUtc } from "./tz";

const CHI = "America/Chicago";

test("zonedTimeToUtc uses the offset in effect on that date, not today's", () => {
  // Standard time: Chicago is UTC-6 in January.
  assert.equal(zonedTimeToUtc(2026, 1, 11, 8, 0, CHI).toISOString(), "2026-01-11T14:00:00.000Z");
  // Daylight time: UTC-5 in March, after the 8th.
  assert.equal(zonedTimeToUtc(2026, 3, 15, 8, 0, CHI).toISOString(), "2026-03-15T13:00:00.000Z");
});

test("zonedTimeToUtc handles the hour on either side of the spring-forward", () => {
  // 01:30 exists (CST); 03:30 exists (CDT). 02:30 never happens.
  assert.equal(zonedTimeToUtc(2026, 3, 8, 1, 30, CHI).toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(zonedTimeToUtc(2026, 3, 8, 3, 30, CHI).toISOString(), "2026-03-08T08:30:00.000Z");
});

test("tzOffsetMs reports the zone's offset at an instant", () => {
  assert.equal(tzOffsetMs(new Date("2026-01-11T14:00:00Z"), CHI), -6 * 3600 * 1000);
  assert.equal(tzOffsetMs(new Date("2026-07-11T14:00:00Z"), CHI), -5 * 3600 * 1000);
});

test("localDateKey reports the local calendar day, not the UTC one", () => {
  // 02:00Z on the 12th is still the evening of the 11th in Chicago.
  assert.equal(localDateKey(new Date("2026-01-12T02:00:00Z"), CHI), "2026-01-11");
  assert.equal(localDateKey(new Date("2026-01-12T12:00:00Z"), CHI), "2026-01-12");
});

test("zonedParts reads midnight as hour 0, not 24", () => {
  const p = zonedParts(new Date("2026-01-11T06:00:00Z"), CHI);
  assert.equal(p.hour, 0);
  assert.equal(p.day, 11);
});

test("addDays crosses month and year ends", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01"); // 2026 is not a leap year
});

test("weekdayOf counts Sunday as 0", () => {
  assert.equal(weekdayOf("2026-01-11"), 0);
  assert.equal(weekdayOf("2026-01-12"), 1);
  assert.equal(weekdayOf("2026-01-17"), 6);
});

test("parseHM rejects what is not a wall-clock time", () => {
  assert.equal(parseHM("08:00"), 480);
  assert.equal(parseHM("8:05"), 485);
  assert.equal(parseHM("23:59"), 1439);
  assert.equal(parseHM("24:00"), null);
  assert.equal(parseHM("8"), null);
  assert.equal(parseHM(""), null);
});
