import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  checkStatusChange, computeGaps, isIsoDate, lateMediaWarning, parseContentInput, parseEventInput,
  parseMediaInput, readyBlockers, resolveMediaStatus, seriesStatusToPipeline,
  GapItem, GapMedia,
} from "./pipeline/rules";
import { captionWarnings, countChars, imageRuleError } from "./pipeline/platforms";

test("isIsoDate accepts real calendar dates only", () => {
  assert.equal(isIsoDate("2026-11-01"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("2026-11-1"), false);
  assert.equal(isIsoDate("Nov 1"), false);
  assert.equal(isIsoDate(null), false);
});

test("content create needs a title and a publish date; patches need neither", () => {
  assert.deepEqual(parseContentInput({ publishDate: "2026-11-01" }, "create"), { ok: false, error: "Give the post a title." });
  assert.deepEqual(parseContentInput({ title: "Camp" }, "create"), { ok: false, error: "Pick a publish date." });
  const ok = parseContentInput({ title: " Camp ", publishDate: "2026-11-01", platforms: ["instagram", "instagram"] }, "create");
  assert.ok(ok.ok);
  assert.equal(ok.value.title, "Camp");
  assert.deepEqual(ok.value.platforms, ["instagram"]);
  assert.ok(parseContentInput({ status: "drafted" }, "patch").ok);
});

test("content input rejects bad statuses, dates, platforms and times with a clear message", () => {
  const bad = (body: unknown) => { const r = parseContentInput(body, "patch"); assert.ok(!r.ok); return r.error; };
  assert.match(bad({ status: "done" }), /Status must be one of/);
  assert.match(bad({ publishDate: "11/01/2026" }), /Publish date must be a date/);
  assert.match(bad({ platforms: ["tiktok"] }), /Platforms must be chosen from/);
  assert.match(bad({ publishTime: "9am" }), /Publish time/);
  assert.match(bad({ ownerEmail: "not-an-email" }), /Owner must be an email/);
  assert.match(bad({ title: "" }), /title/);
});

test("clearing dates and events uses null", () => {
  const r = parseContentInput({ publishDate: "", eventId: "", publishTime: null }, "patch");
  assert.ok(r.ok);
  assert.deepEqual(r.value, { publishDate: null, eventId: null, publishTime: null });
});

test("media input validation", () => {
  assert.deepEqual(parseMediaInput({}, "create"), { ok: false, error: "Describe what needs collecting." });
  const r = parseMediaInput({ type: "drone" }, "patch");
  assert.ok(!r.ok);
  assert.match(r.error, /Media type must be one of/);
  const link = parseMediaInput({ fileLink: "drive/folder" }, "patch");
  assert.ok(!link.ok);
  assert.ok(parseMediaInput({ description: "Check-in table", type: "photo", gatherDate: "2026-11-01" }, "create").ok);
});

test("event validation, including the date range", () => {
  assert.ok(!parseEventInput({}, "create").ok);
  const range = parseEventInput({ name: "Camp", startDate: "2026-07-10", endDate: "2026-07-01" }, "create");
  assert.ok(!range.ok);
  assert.match(range.error, /end date is before/);
  assert.ok(!parseEventInput({ color: "navy" }, "patch").ok);
  assert.ok(parseEventInput({ name: "Youth Ministry", kind: "department", color: "#092D3E" }, "create").ok);
});

test("gather date moves media between Needed and Scheduled", () => {
  const needed = { status: "needed" as const, gatherDate: null };
  const scheduled = { status: "scheduled" as const, gatherDate: "2026-11-01" };
  assert.deepEqual(resolveMediaStatus(needed, { gatherDate: "2026-11-01" }), { ok: true, value: "scheduled" });
  assert.deepEqual(resolveMediaStatus(scheduled, { gatherDate: null }), { ok: true, value: "needed" });
  // Captured media keeps its status whatever happens to the date.
  assert.deepEqual(resolveMediaStatus({ status: "captured", gatherDate: "2026-11-01" }, { gatherDate: null }), { ok: true, value: "captured" });
  // An explicit status wins...
  assert.deepEqual(resolveMediaStatus(scheduled, { status: "captured" }), { ok: true, value: "captured" });
  // ...but Scheduled needs a date.
  assert.ok(!resolveMediaStatus(needed, { status: "scheduled" }).ok);
  // Untouched date, untouched status.
  assert.deepEqual(resolveMediaStatus(needed, { notes: "x" }), { ok: true, value: "needed" });
});

test("the Ready gate", () => {
  const photo = { id: "m1", description: "Check-in photo", status: "scheduled" as const };
  const done = { id: "m2", description: "Interview", status: "edited" as const };
  assert.equal(readyBlockers({ noMediaNeeded: false }, [done]).length, 0);
  assert.deepEqual(readyBlockers({ noMediaNeeded: false }, [photo, done]), ["Check-in photo (scheduled)"]);
  assert.equal(readyBlockers({ noMediaNeeded: true }, [photo]).length, 0);
  // No media listed and no flag: nobody has decided, so not ready.
  assert.equal(readyBlockers({ noMediaNeeded: false }, []).length, 1);

  const blocked = checkStatusChange("ready", { noMediaNeeded: false }, [photo]);
  assert.ok(!blocked.ok);
  assert.match(blocked.error, /Check-in photo/);
  assert.ok(!checkStatusChange("scheduled", { noMediaNeeded: false }, [photo]).ok);
  // Moving backwards, cancelling, or recording a publish are never gated.
  assert.ok(checkStatusChange("idea", { noMediaNeeded: false }, [photo]).ok);
  assert.ok(checkStatusChange("cancelled", { noMediaNeeded: false }, [photo]).ok);
  assert.ok(checkStatusChange("published", { noMediaNeeded: false }, [photo]).ok);
});

test("legacy series statuses map onto pipeline statuses", () => {
  assert.equal(seriesStatusToPipeline("pending"), "idea");
  assert.equal(seriesStatusToPipeline("drafted"), "drafted");
  assert.equal(seriesStatusToPipeline("posted"), "published");
  assert.equal(seriesStatusToPipeline("weird"), "idea");
});

test("late media warning", () => {
  assert.match(lateMediaWarning("2026-11-05", "2026-11-01"), /after the post's publish date/);
  assert.equal(lateMediaWarning("2026-11-01", "2026-11-01"), "");
  assert.equal(lateMediaWarning(null, "2026-11-01"), "");
});

test("the five gap alerts", () => {
  const today = "2026-11-01";
  const item = (id: string, publishDate: string | null, status: GapItem["status"], mediaCount = 1, noMediaNeeded = false): GapItem =>
    ({ id, publishDate, status, mediaCount, noMediaNeeded });
  const items: GapItem[] = [
    item("soon-drafted", "2026-11-05", "drafted"),
    item("soon-ready", "2026-11-05", "ready"),
    item("soon-cancelled", "2026-11-05", "cancelled"),
    item("later-idea", "2026-11-20", "idea"),
    item("no-media", "2026-11-20", "planned", 0),
    item("no-media-flagged", "2026-11-20", "planned", 0, true),
    item("no-media-old", "2026-09-01", "idea", 0),
    item("no-media-published", "2026-11-20", "published", 0),
  ];
  const media = (id: string, gatherDate: string | null, status: GapMedia["status"], itemPublishDate: string, itemStatus: GapMedia["itemStatus"] = "planned"): GapMedia =>
    ({ id, contentItemId: "x", gatherDate, status, itemPublishDate, itemStatus });
  const mediaRows: GapMedia[] = [
    media("unsched-soon", null, "needed", "2026-11-15"),
    media("unsched-far", null, "needed", "2026-12-15"),
    media("late", "2026-11-10", "scheduled", "2026-11-08"),
    media("late-but-captured", "2026-11-10", "captured", "2026-11-08"),
    media("overdue", "2026-10-30", "scheduled", "2026-11-08"),
    media("overdue-cancelled", "2026-10-30", "scheduled", "2026-11-08", "cancelled"),
  ];
  const gaps = computeGaps(items, mediaRows, today, { readinessDays: 7, unscheduledMediaDays: 21 });
  const ids = Object.fromEntries(gaps.map((g) => [g.key, g.ids]));
  assert.deepEqual(ids["not-ready"], ["soon-drafted"]);
  assert.deepEqual(ids["no-media"], ["no-media"]);
  assert.deepEqual(ids["unscheduled-media"], ["unsched-soon"]);
  assert.deepEqual(ids["late-media"], ["late"]);
  assert.deepEqual(ids["overdue-media"], ["overdue"]);
  assert.equal(gaps.length, 5);
  assert.equal(gaps[0].count, 1);
});

test("characters count the way each platform counts them", () => {
  const text = "Advent starts Sunday https://grmc.org/a-very-long-path/that-goes-on-and-on";
  assert.equal(countChars("x", text), "Advent starts Sunday ".length + 23, "X charges 23 for a link");
  assert.equal(countChars("facebook", text), text.length);
  assert.equal(countChars("x", "🙏 pray"), 6, "an emoji is one character");
});

test("caption warnings only for selected platforms that are over", () => {
  const long = "a".repeat(300);
  assert.deepEqual(captionWarnings({ platforms: ["facebook"], captionMode: "same", caption: long, captions: {} }), []);
  assert.equal(captionWarnings({ platforms: ["facebook", "x"], captionMode: "same", caption: long, captions: {} }).length, 1);
  assert.equal(captionWarnings({ platforms: ["x"], captionMode: "separate", caption: long, captions: { x: "short" } }).length, 0);
});

test("text-only posts can't include Instagram", () => {
  assert.match(imageRuleError(["instagram", "facebook"], true), /Instagram can't take a text-only post/);
  assert.equal(imageRuleError(["facebook", "x"], true), "");
  assert.equal(imageRuleError(["instagram"], false), "");
});

test("captions per platform are validated", () => {
  assert.ok(parseContentInput({ captionMode: "separate", captions: { x: "hi", instagram: "hello" } }, "patch").ok);
  assert.ok(!parseContentInput({ captionMode: "each" }, "patch").ok);
  assert.ok(!parseContentInput({ captions: { tiktok: "hi" } }, "patch").ok);
});

test("attaching a file finishes media; removing it leaves it collected", () => {
  const scheduled = { status: "scheduled" as const, gatherDate: "2026-11-01", fileLink: "", approvalId: null };
  assert.deepEqual(resolveMediaStatus(scheduled, { approvalId: 7 }), { ok: true, value: "edited" });
  assert.deepEqual(resolveMediaStatus(scheduled, { fileLink: "https://drive/x" }), { ok: true, value: "edited" });
  assert.deepEqual(resolveMediaStatus({ ...scheduled, status: "edited", approvalId: 7 }, { approvalId: null }), { ok: true, value: "captured" });
  assert.deepEqual(resolveMediaStatus(scheduled, { status: "captured" }), { ok: true, value: "captured" }, "collected with no file at all");
});
