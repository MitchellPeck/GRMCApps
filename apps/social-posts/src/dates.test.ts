import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatMonthDayYear, isWeekday, suggestDate, suggestDateTime, todayInTimezone } from "./dates";

test("a weekday resolves to that day inside the reference week", () => {
  // 2026-06-10 is a Wednesday; its week runs Sun Jun 7 - Sat Jun 13.
  assert.equal(suggestDate({ kind: "weekday", weekday: "wednesday" }, "2026-06-10"), "2026-06-10");
  assert.equal(suggestDate({ kind: "weekday", weekday: "saturday" }, "2026-06-10"), "2026-06-13");
  assert.equal(suggestDate({ kind: "weekday", weekday: "monday" }, "2026-06-10"), "2026-06-08");
  // Sunday is the start of the week, so a Sunday reference stays put.
  assert.equal(suggestDate({ kind: "weekday", weekday: "sunday" }, "2026-06-07"), "2026-06-07");
  assert.equal(suggestDate({ kind: "weekday", weekday: "friday" }, "2026-06-07"), "2026-06-12");
});

test("a series label resolves to that calendar date in the reference year", () => {
  assert.equal(suggestDate({ kind: "seriesDate", label: "Jun 16" }, "2026-06-10"), "2026-06-16");
  assert.equal(suggestDate({ kind: "seriesDate", label: "" }, "2026-06-10"), "");
  assert.equal(suggestDate({ kind: "seriesDate", label: "Someday" }, "2026-06-10"), "");
});

test("unknown weekdays and missing reference dates yield no suggestion", () => {
  assert.equal(suggestDate({ kind: "weekday", weekday: "someday" }, "2026-06-10"), "");
  assert.equal(suggestDate({ kind: "weekday", weekday: "monday" }, ""), "");
  assert.equal(suggestDateTime({ kind: "weekday", weekday: "someday" }, { refDate: "2026-06-10", time: "09:00" }), "");
  assert.equal(suggestDateTime({ kind: "weekday", weekday: "wednesday" }, { refDate: "2026-06-10", time: "09:00" }), "2026-06-10T09:00:00");
});

test("isWeekday recognises post keys, not run names", () => {
  assert.equal(isWeekday("wednesday"), true);
  assert.equal(isWeekday("Saturday"), true);
  assert.equal(isWeekday("blog"), false);
  assert.equal(isWeekday(""), false);
});

test("todayInTimezone uses the church's local date, not the container's UTC date", () => {
  // 02:30 UTC on Aug 5 is still Aug 4 in Marietta.
  const now = new Date("2026-08-05T02:30:00Z");
  assert.equal(todayInTimezone("America/New_York", now), "2026-08-04");
  assert.equal(todayInTimezone("UTC", now), "2026-08-05");
});

test("formatMonthDayYear keeps bare dates from sliding a day backwards", () => {
  assert.equal(formatMonthDayYear("2026-08-05", "America/New_York"), "Aug 5, 2026");
  assert.equal(formatMonthDayYear("2026-07-31T14:02:00+00:00", "America/New_York"), "Jul 31, 2026");
  assert.equal(formatMonthDayYear(""), "");
  assert.equal(formatMonthDayYear("not a date"), "");
});
