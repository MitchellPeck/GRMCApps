import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, isValidTimeZone, parseSettings } from "./settings";

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
