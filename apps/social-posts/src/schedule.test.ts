import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectAngles } from "./podcast-angles";
import { podcastScheduleDates } from "./schedule";

test("podcast posts are scheduled off the episode's publish date, not this week", () => {
  // The whole point of drafting before the drop: an episode landing next
  // Sunday schedules its announcement for next Sunday, however far off it is.
  const dates = podcastScheduleDates(selectAngles(["announcement", "quote"]), "2026-09-27");
  assert.equal(dates.announcement, "2026-09-27", "the announcement goes out the day it drops");
  assert.equal(dates.quote, "2026-10-01", "later angles are staggered after the drop");
});

test("podcastScheduleDates suggests nothing when the episode has no publish date", () => {
  assert.deepEqual(podcastScheduleDates(selectAngles(["announcement"]), ""), {});
});
