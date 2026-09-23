import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS, isValidTimeZone, parseSettings, SETTABLE_KEYS, SETTING_VALIDATORS,
  unknownSettingKeys, validateSettings,
} from "./settings";

test("an empty database yields the defaults", () => {
  assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS);
});

test("stored values are read back", () => {
  const s = parseSettings({
    timezone: "America/New_York",
    image_seconds: "20",
    slide_seconds: "8",
    transition: "none",
    fit: "cover",
    background: "#000000",
    clock: "time_date",
    clock_position: "top-left",
    poll_seconds: "30",
    video_loop_single: "false",
  });
  assert.equal(s.timezone, "America/New_York");
  assert.equal(s.imageSeconds, 20);
  assert.equal(s.slideSeconds, 8);
  assert.equal(s.transition, "none");
  assert.equal(s.fit, "cover");
  assert.equal(s.clock, "time_date");
  assert.equal(s.clockPosition, "top-left");
  assert.equal(s.pollSeconds, 30);
  assert.equal(s.videoLoopSingle, false);
});

test("a nonsense stored value never stops the TV — it falls back", () => {
  const s = parseSettings({
    timezone: "Mars/Olympus",
    image_seconds: "not a number",
    transition: "explode",
    fit: "squish",
    background: "chartreuse",
    clock: "sundial",
    poll_seconds: "0",
  });
  assert.equal(s.timezone, DEFAULT_SETTINGS.timezone);
  assert.equal(s.imageSeconds, DEFAULT_SETTINGS.imageSeconds);
  assert.equal(s.transition, DEFAULT_SETTINGS.transition);
  assert.equal(s.fit, DEFAULT_SETTINGS.fit);
  assert.equal(s.background, DEFAULT_SETTINGS.background);
  assert.equal(s.clock, DEFAULT_SETTINGS.clock);
  assert.equal(s.pollSeconds, 3); // clamped into range, not discarded
});

test("durations are clamped rather than rejected", () => {
  assert.equal(parseSettings({ image_seconds: "99999" }).imageSeconds, 3600);
  assert.equal(parseSettings({ image_seconds: "-4" }).imageSeconds, 1);
  assert.equal(parseSettings({ transition_ms: "99999" }).transitionMs, 5000);
});

test("isValidTimeZone knows a real zone from a typo", () => {
  assert.equal(isValidTimeZone("America/Chicago"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("America/Chicagoo"), false);
  assert.equal(isValidTimeZone(""), false);
});

test("every field of AppSettings has a validator, so none can be forgotten", () => {
  // The bug: hoursMode was in AppSettings, in KEYS and in the UI, but the
  // route's hand-written if-chain had no branch for it, so choosing scheduled
  // hours answered 200 and changed nothing. The mapped type now makes that a
  // compile error; this asserts it at runtime too.
  for (const field of Object.keys(DEFAULT_SETTINGS)) {
    assert.ok(field in SETTING_VALIDATORS, `${field} has no validator`);
    assert.ok(SETTABLE_KEYS.includes(field), `${field} cannot be saved`);
  }
});

test("choosing scheduled hours is actually saved — the reported bug", () => {
  const saved = validateSettings({ hoursMode: "scheduled" });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.deepEqual(saved.value, { hoursMode: "scheduled" });
  assert.equal(parseSettings({ hours_mode: "scheduled" }).hoursMode, "scheduled");
});

test("every validator rejects nonsense with a reason rather than accepting it", () => {
  const bad: Record<string, unknown> = {
    timezone: "Mars/Olympus", transition: "explode", fit: "squish",
    background: "chartreuse", clock: "sundial", clockPosition: "middle",
    hoursMode: "sometimes",
  };
  for (const [field, value] of Object.entries(bad)) {
    const r = validateSettings({ [field]: value });
    assert.equal(r.ok, false, `${field} accepted ${value}`);
    if (!r.ok) assert.ok(r.error.length > 10, `${field} gave no useful reason`);
  }
});

test("numbers are clamped into range rather than refused", () => {
  const r = validateSettings({ imageSeconds: 99999, pollSeconds: 0 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.imageSeconds, 3600);
  assert.equal(r.value.pollSeconds, 3);
});

test("a body with nothing in it is a valid no-op", () => {
  const r = validateSettings({});
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, {});
});

test("a field the endpoint does not handle is named, not ignored", () => {
  assert.deepEqual(unknownSettingKeys({ timezone: "UTC", hoursMode: "always" }), []);
  assert.deepEqual(unknownSettingKeys({ defaultPlaylistId: 3 }), []);
  assert.deepEqual(unknownSettingKeys({ hoursmode: "x", colour: 1 }), ["hoursmode", "colour"]);
});
