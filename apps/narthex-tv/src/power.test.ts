import { test } from "node:test";
import assert from "node:assert/strict";
import { HoursWindow, mergedSpans, resolvePower, validateWindow } from "./power";

const CHI = "America/Chicago";
const at = (iso: string) => new Date(iso);

let nextId = 1;
function w(day: number, startTime: string, endTime: string, enabled = true): HoursWindow {
  return { id: nextId++, day, startTime, endTime, enabled };
}

// Office hours Monday-Friday, plus Sunday morning.
const CHURCH: HoursWindow[] = [
  w(0, "07:30", "13:00"),
  w(1, "08:00", "17:00"),
  w(2, "08:00", "17:00"),
  w(3, "08:00", "17:00"),
  w(4, "08:00", "17:00"),
  w(5, "08:00", "17:00"),
];

test("always-on ignores the grid entirely", () => {
  const state = resolvePower("always", CHURCH, at("2026-01-12T08:00:00Z"), CHI);
  assert.equal(state.on, true);
  assert.equal(state.changesAt, null);
});

test("the screen is awake inside a window and dark outside it", () => {
  // Monday 09:00 CST = 15:00Z.
  assert.equal(resolvePower("scheduled", CHURCH, at("2026-01-12T15:00:00Z"), CHI).on, true);
  // Monday 22:00 CST = Tuesday 04:00Z.
  assert.equal(resolvePower("scheduled", CHURCH, at("2026-01-13T04:00:00Z"), CHI).on, false);
  // Sunday 08:00 CST = 14:00Z.
  assert.equal(resolvePower("scheduled", CHURCH, at("2026-01-11T14:00:00Z"), CHI).on, true);
  // Saturday has no window at all.
  assert.equal(resolvePower("scheduled", CHURCH, at("2026-01-17T15:00:00Z"), CHI).on, false);
});

test("it reports when the screen next goes dark", () => {
  // Monday 09:00 CST; the window ends at 17:00 CST = 23:00Z.
  const state = resolvePower("scheduled", CHURCH, at("2026-01-12T15:00:00Z"), CHI);
  assert.equal(state.changesAt?.toISOString(), "2026-01-12T23:00:00.000Z");
});

test("it reports when the screen next wakes up", () => {
  // Saturday afternoon; next window is Sunday 07:30 CST = 13:30Z.
  const state = resolvePower("scheduled", CHURCH, at("2026-01-17T20:00:00Z"), CHI);
  assert.equal(state.on, false);
  assert.equal(state.changesAt?.toISOString(), "2026-01-18T13:30:00.000Z");
});

test("hours follow the clock through daylight saving", () => {
  // 09:00 local on a CDT Monday is 14:00Z, not 15:00Z.
  assert.equal(resolvePower("scheduled", CHURCH, at("2026-03-16T14:00:00Z"), CHI).on, true);
  // And 07:00 local is still dark.
  assert.equal(resolvePower("scheduled", CHURCH, at("2026-03-16T12:00:00Z"), CHI).on, false);
});

test("overlapping windows do not blink the screen off between them", () => {
  const split = [w(1, "08:00", "12:00"), w(1, "11:00", "17:00")];
  // 11:30 CST = 17:30Z falls in both.
  const state = resolvePower("scheduled", split, at("2026-01-12T17:30:00Z"), CHI);
  assert.equal(state.on, true);
  // It stays awake to the LATER end, not the earlier one.
  assert.equal(state.changesAt?.toISOString(), "2026-01-12T23:00:00.000Z");
});

test("windows that touch exactly are one stretch", () => {
  const touching = [w(1, "08:00", "12:00"), w(1, "12:00", "17:00")];
  const state = resolvePower("scheduled", touching, at("2026-01-12T17:00:00Z"), CHI);
  assert.equal(state.on, true);
  assert.equal(state.changesAt?.toISOString(), "2026-01-12T23:00:00.000Z");
});

test("a window that runs past midnight stays awake after it", () => {
  const christmasEve = [w(3, "22:00", "01:00")];
  // Wednesday 23:00 CST = Thursday 05:00Z.
  assert.equal(resolvePower("scheduled", christmasEve, at("2026-01-15T05:00:00Z"), CHI).on, true);
  // Thursday 00:30 CST = 06:30Z — still the Wednesday window.
  assert.equal(resolvePower("scheduled", christmasEve, at("2026-01-15T06:30:00Z"), CHI).on, true);
  // Thursday 01:30 CST = 07:30Z — over.
  assert.equal(resolvePower("scheduled", christmasEve, at("2026-01-15T07:30:00Z"), CHI).on, false);
});

test("a disabled window does not wake the screen", () => {
  const off = [w(1, "08:00", "17:00", false)];
  assert.equal(resolvePower("scheduled", off, at("2026-01-12T15:00:00Z"), CHI).on, false);
});

test("an empty grid keeps the screen on rather than going dark forever", () => {
  const state = resolvePower("scheduled", [], at("2026-01-12T15:00:00Z"), CHI);
  assert.equal(state.on, true);
  assert.equal(state.changesAt, null);
});

test("rows that exist are obeyed even when every one is switched off", () => {
  // Distinct from an empty grid: these rows are somebody's decision, so the
  // screen stays dark and the admin UI is what warns about it.
  const state = resolvePower("scheduled", [w(1, "08:00", "17:00", false)], at("2026-01-17T15:00:00Z"), CHI);
  assert.equal(state.on, false);
  assert.equal(state.changesAt, null);
});

test("mergedSpans covers the coming week so a next-wake is always found", () => {
  const sundayOnly = [w(0, "07:30", "13:00")];
  const spans = mergedSpans(sundayOnly, at("2026-01-12T15:00:00Z"), CHI);
  assert.ok(spans.length >= 1);
  assert.ok(spans.every((s) => s.end.getTime() > s.start.getTime()));
});

test("validateWindow rejects what could never be a window", () => {
  assert.equal(validateWindow({ day: 1, startTime: "08:00", endTime: "17:00" }).ok, true);
  assert.equal(validateWindow({ day: 7, startTime: "08:00", endTime: "17:00" }).ok, false);
  assert.equal(validateWindow({ day: 1, startTime: "8am", endTime: "17:00" }).ok, false);
  assert.equal(validateWindow({ day: 1, startTime: "08:00", endTime: "" }).ok, false);
});
