import { strict as assert } from "node:assert";
import { test } from "node:test";
import { durationLabel, episodeDateLine, htmlToText, isPublished, listenUrlFor, toEpisode } from "./buzzsprout";

test("htmlToText turns Buzzsprout's HTML description into readable plain text", () => {
  const html = '<p>Rev. Williams on <strong>Acts 2</strong>.</p><p>What does it mean&nbsp;to be the church?</p><br><a href="https://x.test">Link</a>';
  const out = htmlToText(html);
  assert.ok(!out.includes("<"), "no tags survive");
  assert.ok(out.includes("Rev. Williams on Acts 2."), "text content kept");
  assert.ok(out.includes("What does it mean to be the church?"), "entities decoded");
  // Paragraph breaks are the only structure worth keeping — the prompt reads
  // better with them than with one run-on line.
  assert.ok(/Acts 2\.\s*\n/.test(out), "paragraph boundary becomes a line break");
  assert.ok(!/\n{3,}/.test(out), "no runs of blank lines");
});

test("isPublished treats a future publish date and a private episode as not live", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  assert.equal(isPublished({ published_at: "2026-09-14T03:00:00.000-04:00", private: false }, now), true);
  assert.equal(isPublished({ published_at: "2026-09-27T03:00:00.000-04:00", private: false }, now), false, "future date is not live");
  assert.equal(isPublished({ published_at: "2026-09-14T03:00:00.000-04:00", private: true }, now), false, "private is not live");
});

test("episodeDateLine never calls an unpublished episode published", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const tz = "America/New_York";

  const live = episodeDateLine({ published_at: "2026-09-14T03:00:00.000-04:00", private: false, episode_number: 12 }, tz, now);
  assert.equal(live, "Episode 12 · published Sep 14, 2026");

  const scheduled = episodeDateLine({ published_at: "2026-09-27T03:00:00.000-04:00", private: false, episode_number: 13 }, tz, now);
  assert.equal(scheduled, "Episode 13 · scheduled for Sep 27, 2026");
  assert.ok(!scheduled.includes("published"), "a scheduled episode is never captioned as published");

  const secret = episodeDateLine({ published_at: "2026-09-14T03:00:00.000-04:00", private: true, episode_number: 14 }, tz, now);
  assert.equal(secret, "Episode 14 · private, not published");

  const unnumbered = episodeDateLine({ published_at: "2026-09-14T03:00:00.000-04:00", private: false, episode_number: null }, tz, now);
  assert.equal(unnumbered, "published Sep 14, 2026", "no episode number, no empty prefix");
});

test("listenUrlFor prefers the episode's custom url over the derived one", () => {
  assert.equal(
    listenUrlFor({ id: 788881, custom_url: "https://grmc.app/podcast/12" }, "140447"),
    "https://grmc.app/podcast/12"
  );
  assert.equal(
    listenUrlFor({ id: 788881, custom_url: null }, "140447"),
    "https://www.buzzsprout.com/140447/episodes/788881"
  );
  assert.equal(listenUrlFor({ id: 788881, custom_url: "" }, ""), "", "no podcast id, no invented url");
});

test("durationLabel reads as something a person would write in a post", () => {
  assert.equal(durationLabel(1236), "21 min");
  assert.equal(durationLabel(45), "1 min");
  assert.equal(durationLabel(3900), "1 hr 5 min");
  assert.equal(durationLabel(7200), "2 hr");
  assert.equal(durationLabel(0), "");
});

const RAW = {
  id: 788881,
  title: "Too small or too big?",
  description: "<p>Rev. Williams on <strong>Acts 2</strong>.</p>",
  artwork_url: "https://art.test/a.jpg",
  custom_url: null,
  published_at: "2026-09-27T03:00:00.000-04:00",
  duration: 1236,
  episode_number: 13,
  season_number: 2,
  private: false,
};
const NOW = new Date("2026-09-20T12:00:00Z");

test("toEpisode turns the API row into what the picker and the prompt need", () => {
  const ep = toEpisode(RAW, "140447", "America/New_York", NOW);
  assert.equal(ep.title, "Too small or too big?");
  assert.equal(ep.description, "Rev. Williams on Acts 2.", "description arrives as plain text");
  assert.equal(ep.listenUrl, "https://www.buzzsprout.com/140447/episodes/788881");
  assert.equal(ep.publishDate, "2026-09-27", "the local calendar date it drops, which the scheduler keys off");
  assert.equal(ep.isPublished, false, "it hasn't dropped yet");
  assert.equal(ep.dateLine, "Episode 13 · scheduled for Sep 27, 2026");
  assert.equal(ep.durationLabel, "21 min");
  assert.equal(ep.label, "#13 — Too small or too big?");
});

test("toEpisode labels an unnumbered episode by title alone", () => {
  const ep = toEpisode({ ...RAW, episode_number: null }, "140447", "America/New_York", NOW);
  assert.equal(ep.label, "Too small or too big?", "no number, no stray '#'");
});

test("toEpisode caps the description so one episode can't swallow the prompt", () => {
  const ep = toEpisode({ ...RAW, description: "<p>" + "word ".repeat(3000) + "</p>" }, "140447", "America/New_York", NOW);
  assert.ok(ep.description.length <= 4000, "capped like the Mailchimp preview is");
  assert.ok(ep.description.length > 3000, "but not truncated to nothing");
});
