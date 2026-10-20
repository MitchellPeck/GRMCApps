import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BLOG_PROFILE, DEFAULT_VOICE, GRACE_NOTES_PROFILE, PODCAST_PROFILE, SUNDAY_PROFILE } from "./pipeline/drafting-seed";
import { PromptInput, buildDraftPrompt } from "./pipeline/prompt";

const base: PromptInput = {
  voice: DEFAULT_VOICE, context: "", instructions: "", eventName: "", eventKind: "", eventDates: "",
  title: "Grace Notes", brief: "", phase: "", publishDate: "2026-10-21", seriesPosition: null, source: null,
  platforms: ["instagram", "facebook"], captionMode: "same", caption: "", captions: {},
};

test("seeded profiles carry today's run instructions word for word", () => {
  assert.equal(GRACE_NOTES_PROFILE.instructions,
    "Warm summary of what is inside this week Grace Notes. End with the archive link. Make people feel there is something worth reading, not just a notification.");
  assert.deepEqual(GRACE_NOTES_PROFILE.source, { kind: "mailchimp", subjectContains: "grace notes", cutoff: "followingSunday" });
  assert.match(SUNDAY_PROFILE.instructions!, /^Anticipatory invite for this Sunday's service\. Warm, specific to what is happening\. Should make someone who has not been in a while feel welcomed back\./);
  assert.deepEqual(BLOG_PROFILE.source, { kind: "mailchimp", subjectContains: "weekly blog", cutoff: "latest" });
  assert.match(BLOG_PROFILE.instructions!, /^Tease the most compelling idea or question from the blog\. Make someone want to read it\./);
  assert.deepEqual(PODCAST_PROFILE.angles!.map((a) => [a.key, a.offsetDays]),
    [["announcement", 0], ["question", 2], ["quote", 4], ["guest", 1], ["invite", 5]]);
  assert.match(DEFAULT_VOICE, /^GRMC voice rules: short, punchy, warm but not stiff\./);
});

test("a Grace Notes draft prompt reads like the Wednesday run's", () => {
  const p = buildDraftPrompt({ ...base, instructions: GRACE_NOTES_PROFILE.instructions!, source: {
    kind: "mailchimp", id: "c1", title: "Grace Notes - October 18, 2026", url: "https://mailchi.mp/x", date: "2026-10-18",
    dateLine: "Sent Oct 15, 2026", content: "This week: the harvest supper.",
  } });
  assert.ok(p.user.includes(DEFAULT_VOICE));
  assert.ok(p.user.includes(GRACE_NOTES_PROFILE.instructions!));
  assert.match(p.user, /SOURCE: Grace Notes - October 18, 2026/);
  assert.match(p.user, /SOURCE URL: https:\/\/mailchi\.mp\/x/);
  assert.match(p.user, /This week: the harvest supper\./);
  assert.deepEqual(p.keys, ["post"]);
  assert.match(p.system, /Return ONLY a JSON object/);
});

test("an unsent campaign and an unreleased episode are flagged to Claude", () => {
  const draft = buildDraftPrompt({ ...base, source: { kind: "mailchimp", id: "c", title: "T", url: "", date: "", dateLine: "", content: "x", isDraft: true } });
  assert.match(draft.user, /not been sent yet/);
  const ep = buildDraftPrompt({ ...base, source: { kind: "buzzsprout", id: "9", title: "Too small?", url: "https://buzz/9", date: "2026-11-01",
    dateLine: "Drops Nov 1, 2026", content: "Show notes", notYetPublic: true, durationLabel: "32 min" } });
  assert.match(ep.user, /EPISODE TITLE: Too small\?/);
  assert.match(ep.user, /LISTEN URL: https:\/\/buzz\/9/);
  assert.match(ep.user, /EPISODE LENGTH: 32 min/);
  assert.match(ep.user, /NOT YET PUBLIC: this episode is Drops Nov 1, 2026\. Write as though it is landing, not as though it is already out\./);
});

test("separate captions ask for one key per platform, with each platform's guidance", () => {
  const p = buildDraftPrompt({ ...base, platforms: ["instagram", "x"], captionMode: "separate", captions: { x: "Old X" } });
  assert.deepEqual(p.keys, ["instagram", "x"]);
  assert.match(p.user, /link in bio/);
  assert.match(p.user, /Hard limit 280 characters/);
  assert.match(p.user, /X: Old X/, "current drafts are passed back to improve on");
  assert.match(p.system, /"instagram", "x"/);
});

test("same caption going to X must fit X; series posts say where they sit", () => {
  const p = buildDraftPrompt({ ...base, platforms: ["facebook", "x"], seriesPosition: { n: 3, of: 13 }, phase: "Our roots", context: "Founded 2022." });
  assert.match(p.user, /at most 280 characters/);
  assert.match(p.user, /THIS POST: 3 of 13/);
  assert.match(p.user, /PHASE: Our roots/);
  assert.match(p.user, /BACKGROUND AND KEY MESSAGES: Founded 2022\./);
});
