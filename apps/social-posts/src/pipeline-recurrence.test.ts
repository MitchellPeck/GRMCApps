import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Rule, describeRule, occurrences, parseRecurrenceInput, parseRule } from "./pipeline/recurrence";
import { buildCaptureIcs } from "./pipeline/ical";
import { MediaRow } from "./pipeline/repo";

const base: Rule = {
  freq: "weekly", interval: 1, weekdays: [], monthDay: null, nth: null, weekday: null,
  startDate: "2026-10-20", endDate: null, count: null,
};
const rule = (r: Partial<Rule>): Rule => ({ ...base, ...r });

test("weekly on chosen days, starting mid-week", () => {
  // Tue Oct 20 2026: this week's Sunday is already past, Wednesday isn't.
  assert.deepEqual(occurrences(rule({ weekdays: [0, 3] }), "2026-11-02"),
    ["2026-10-21", "2026-10-25", "2026-10-28", "2026-11-01"]);
});

test("every other week counts weeks from the start week", () => {
  assert.deepEqual(occurrences(rule({ interval: 2, weekdays: [3] }), "2026-11-30"),
    ["2026-10-21", "2026-11-04", "2026-11-18"]);
});

test("monthly on a date clamps to short months", () => {
  assert.deepEqual(occurrences(rule({ freq: "monthly_date", monthDay: 31, startDate: "2027-01-01" }), "2027-04-30"),
    ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
});

test("monthly on the nth or last weekday, every N months", () => {
  assert.deepEqual(occurrences(rule({ freq: "monthly_weekday", nth: 2, weekday: 0 }), "2027-01-31"),
    ["2026-11-08", "2026-12-13", "2027-01-10"], "2nd Sunday; October's (Oct 11) is before the start");
  assert.deepEqual(occurrences(rule({ freq: "monthly_weekday", nth: -1, weekday: 5, interval: 2 }), "2027-03-31"),
    ["2026-10-30", "2026-12-25", "2027-02-26"], "last Friday, every other month");
});

test("end date and count both stop the series", () => {
  assert.deepEqual(occurrences(rule({ weekdays: [3], endDate: "2026-11-04" }), "2027-01-01"), ["2026-10-21", "2026-10-28", "2026-11-04"]);
  assert.deepEqual(occurrences(rule({ weekdays: [3], count: 2 }), "2027-01-01"), ["2026-10-21", "2026-10-28"]);
});

test("rules read like a person wrote them", () => {
  assert.equal(describeRule(rule({ weekdays: [3] })), "Every Wednesday");
  assert.equal(describeRule(rule({ weekdays: [2, 4], interval: 2 })), "Every 2 weeks on Tuesday and Thursday");
  assert.equal(describeRule(rule({ freq: "monthly_date", monthDay: 1 })), "Monthly on the 1st");
  assert.equal(describeRule(rule({ freq: "monthly_weekday", nth: -1, weekday: 5, count: 6 })), "Monthly on the last Friday, 6 times");
  assert.equal(describeRule(rule({ freq: "monthly_date", monthDay: 22, interval: 3 })), "Every 3 months on the 22nd");
});

test("rule validation", () => {
  assert.ok(!parseRule({ freq: "weekly", startDate: "2026-10-20", weekdays: [] }).ok, "needs a day");
  assert.ok(!parseRule({ freq: "daily", startDate: "2026-10-20" }).ok);
  assert.ok(!parseRule({ freq: "monthly_weekday", startDate: "2026-10-20", nth: 5, weekday: 0 }).ok);
  assert.ok(!parseRule({ freq: "monthly_date", startDate: "2026-10-20", monthDay: 32 }).ok);
  assert.ok(!parseRule({ freq: "weekly", startDate: "2026-10-20", weekdays: [1], endDate: "2026-10-01" }).ok);
  const ok = parseRule({ freq: "weekly", startDate: "2026-10-20", weekdays: [3, 3, 0] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.weekdays, [0, 3]);
});

test("recurrence input validation, including the media template", () => {
  const r = { freq: "weekly", startDate: "2026-10-20", weekdays: [3] };
  assert.ok(!parseRecurrenceInput({ rule: r }, "create").ok, "needs a title");
  const ok = parseRecurrenceInput({ title: "Devotional", rule: r, mediaTemplate: [
    { description: "Photo", type: "photo", offsetDays: -2 }, { description: "  ", type: "photo" },
  ] }, "create");
  assert.ok(ok.ok);
  assert.equal(ok.value.mediaTemplate!.length, 1, "blank rows dropped");
  assert.ok(!parseRecurrenceInput({ mediaTemplate: [{ description: "x", type: "drone" }] }, "patch").ok);
  assert.ok(parseRecurrenceInput({ active: false }, "patch").ok, "a patch needn't carry a rule");
});

test("capture feed is valid iCalendar with escaping and folding", () => {
  const m = {
    id: "m1", contentItemId: "c1", description: "Kids, rockets; launch day", type: "photo",
    gatherDate: "2026-10-27", gatherLocation: "Field", assigneeEmail: "a@x.org", status: "scheduled",
    fileLink: "", notes: "Wide shots ".repeat(12), itemTitle: "Day one recap", itemPublishDate: "2026-10-28",
    itemStatus: "idea", eventId: null, eventName: "", eventColor: "",
  } as MediaRow;
  const ics = buildCaptureIcs([m, { ...m, id: "m2", gatherDate: null }], { name: "GRMC", pageUrl: "https://x/p", stamp: new Date("2026-10-20T12:00:00Z") });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261027\r\nDTEND;VALUE=DATE:20261028/);
  assert.match(ics, /SUMMARY:Capture: Kids\\, rockets\\; launch day/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1, "undated media left out");
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, "folded: " + line);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});
