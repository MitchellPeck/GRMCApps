import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import {
  createContent, createEvent, createMedia, dashboardGaps, deleteContent, deleteEvent, getContent,
  deleteMedia, getEvent, listContent, listMedia, updateContent, updateEvent, updateMedia,
} from "./pipeline/repo";
import { BACKFILL_SETTING, backfillOnce, markSentToMetricool } from "./pipeline/sync";
import { RUN_EVENTS } from "./pipeline/config";
import { applyImageRule, createRecurrence, deleteRecurrence, getRecurrence, materialize, seedRunRecurrences, updateRecurrence } from "./pipeline/recurring";
import { duplicateEvent } from "./pipeline/repo";
import { Rule } from "./pipeline/recurrence";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const REF = "2026-11-01";

before(async () => {
  await pool.query("DROP TABLE IF EXISTS media_assets, content_items, recurrences, events");
  await pool.query(SCHEMA_SQL);
  await pool.query("DELETE FROM series_posts");
  await pool.query("DELETE FROM series");
  await pool.query("DELETE FROM post_drafts");
  await pool.query("DELETE FROM settings WHERE key = $1", [BACKFILL_SETTING]);
});

after(async () => {
  await pool.query("DELETE FROM media_assets");
  await pool.query("DELETE FROM content_items");
  await pool.query("DELETE FROM recurrences");
  await pool.query("DELETE FROM events");
  await pool.query("DELETE FROM series_posts");
  await pool.query("DELETE FROM series");
  await pool.query("DELETE FROM post_drafts");
  await pool.query("DELETE FROM settings WHERE key = $1", [BACKFILL_SETTING]);
  await pool.end();
});

test("backfill maps existing series posts once, and only once", async () => {
  // A series as it exists before the pipeline: no items anywhere.
  await pool.query(`INSERT INTO series (id, name, description, status) VALUES ('s-old','Advent','Four weeks','active')`);
  await pool.query(`INSERT INTO series (id, name, status) VALUES ('s-done','Lent','complete')`);
  const rows = [
    ["s-old", 0, "Nov 30", "pending", "", "Hope"],
    ["s-old", 1, "Dec 7", "drafted", "Peace draft", "Peace"],
    ["s-old", 2, "Dec 14", "posted", "Joy draft", "Joy"],
    ["s-old", 3, "Smarch 3", "pending", "", "Love"],
  ];
  for (const [sid, idx, date, status, draft, title] of rows) {
    await pool.query(
      `INSERT INTO series_posts (series_id, post_idx, date, title, sub, status, draft) VALUES ($1,$2,$3,$4,'angle',$5,$6)`,
      [sid, idx, date, title, status, draft],
    );
  }

  const report = await backfillOnce(pool, REF);
  assert.deepEqual(report, { seriesEvents: 2, items: 4 });
  assert.equal(await backfillOnce(pool, REF), null, "second boot does nothing");

  const ev = await pool.query("SELECT * FROM events WHERE series_id IS NOT NULL ORDER BY name");
  assert.deepEqual(ev.rows.map((e) => [e.name, e.kind, e.archived]), [["Advent", "series", false], ["Lent", "series", true]]);
  const runEvents = await pool.query("SELECT id FROM events WHERE id LIKE 'run-%' ORDER BY id");
  assert.deepEqual(runEvents.rows.map((r) => r.id), ["run-friday", "run-podcast", "run-sunday", "run-wednesday"]);

  const items = await pool.query("SELECT * FROM content_items WHERE series_id = 's-old' ORDER BY post_idx");
  assert.deepEqual(items.rows.map((i) => [i.status, i.publish_date]), [
    ["idea", "2026-11-30"], ["drafted", "2026-12-07"], ["published", "2026-12-14"], ["idea", null],
  ]);
  assert.equal(items.rows[1].caption, "Peace draft");
  assert.equal(items.rows[1].brief, "angle");
});

test("media, the Ready gate, warnings and deletes", async () => {
  const camp = await createEvent(pool, { name: "Kids Camp: GALAXY", kind: "event", startDate: "2026-11-10", endDate: "2026-11-14" });
  const post = await createContent(pool, { title: "Camp teaser", publishDate: "2026-11-06", eventId: camp.id, platforms: ["instagram"] }, "me@x.org");
  assert.ok(post.ok);
  const id = post.value.id;
  assert.equal(post.value.status, "idea");
  assert.equal(post.value.eventName, "Kids Camp: GALAXY");

  const blocked = await updateContent(pool, id, { status: "ready" });
  assert.ok(!blocked.ok, "no media and no flag: not ready");

  const m = await createMedia(pool, id, { description: "Check-in photo", gatherDate: "2026-11-08" });
  assert.ok(m.ok);
  assert.equal(m.value.media.status, "scheduled", "date set → Scheduled");
  assert.equal(m.value.warnings.length, 1, "gathered after publish");

  const cleared = await updateMedia(pool, m.value.media.id, { gatherDate: null });
  assert.ok(cleared.ok);
  assert.equal(cleared.value.media.status, "needed");

  const stillBlocked = await updateContent(pool, id, { status: "ready" });
  assert.ok(!stillBlocked.ok);
  assert.match(stillBlocked.error, /Check-in photo/);

  await updateMedia(pool, m.value.media.id, { status: "captured", gatherDate: "2026-11-05" });
  const ready = await updateContent(pool, id, { status: "ready" });
  assert.ok(ready.ok);
  assert.equal(ready.value.item.mediaDone, 1);

  // Moving the post earlier than its media warns.
  const moved = await updateContent(pool, id, { publishDate: "2026-11-02" });
  assert.ok(moved.ok);
  assert.equal(moved.value.warnings.length, 1);

  const evt = await getEvent(pool, camp.id);
  assert.ok(evt.ok);
  assert.equal(evt.value.items.length, 1);
  assert.equal(evt.value.media.length, 1);

  // Deleting the event keeps the post.
  await deleteEvent(pool, camp.id);
  const orphan = await getContent(pool, id);
  assert.ok(orphan.ok);
  assert.equal(orphan.value.item.eventId, null);

  // Deleting the post takes its media with it.
  const del = await deleteContent(pool, id);
  assert.ok(del.ok);
  assert.equal(del.value.mediaDeleted, 1);
  assert.equal((await listMedia(pool, { contentItemId: id })).length, 0);
});

test("filters and gaps read the same records", async () => {
  const p = await createContent(pool, { title: "Youth night", publishDate: "2026-11-03", platforms: ["facebook"] }, "a@x.org");
  assert.ok(p.ok);
  await updateContent(pool, p.value.id, { ownerEmail: "Owner@X.org" });
  const fb = await listContent(pool, { platform: "facebook", from: "2026-11-01", to: "2026-11-30" });
  assert.ok(fb.some((i) => i.id === p.value.id));
  assert.equal((await listContent(pool, { ownerEmail: "owner@x.org" })).length, 1, "owner filter ignores case");
  await updateContent(pool, p.value.id, { status: "cancelled" });
  assert.ok(!(await listContent(pool, {})).some((i) => i.id === p.value.id), "cancelled hidden by default");
  assert.ok((await listContent(pool, { includeCancelled: true })).some((i) => i.id === p.value.id));

  const { gaps } = await dashboardGaps(pool, REF);
  assert.equal(gaps.length, 5);
  for (const g of gaps) assert.equal(g.count, g.ids.length);
});

const weekly = (weekdays: number[], extra: Partial<Rule> = {}): Rule => ({
  freq: "weekly", interval: 1, weekdays, monthDay: null, nth: null, weekday: null,
  startDate: REF, endDate: null, count: null, ...extra,
});
const occ = async (recId: string) => (await pool.query(
  "SELECT * FROM content_items WHERE recurrence_id = $1 ORDER BY occurrence_date", [recId])).rows;

test("a recurring post keeps its next weeks on the calendar, with template media", async () => {
  const r = await createRecurrence(pool, {
    title: "Midweek devotional", brief: "Short reflection", rule: weekly([3]),
    mediaTemplate: [{ description: "Sanctuary photo", type: "photo", offsetDays: -1, assigneeEmail: "p@x.org" }],
  }, "me@x.org", REF);
  assert.ok(r.ok);
  assert.equal(r.value.summary, "Every Wednesday");
  const items = await occ(r.value.id);
  assert.equal(items.length, 8, "56 days of Wednesdays from Sun Nov 1");
  assert.equal(items[0].publish_date, "2026-11-04");
  assert.equal(items[0].status, "planned", "a brief makes it Planned");
  const media = await listMedia(pool, { contentItemId: items[0].id });
  assert.deepEqual(media.map((m) => [m.description, m.gatherDate, m.status, m.assigneeEmail]),
    [["Sanctuary photo", "2026-11-03", "scheduled", "p@x.org"]]);
  assert.equal(await materialize(pool, REF, "2026-12-27"), 0, "idempotent");
  // Paging the calendar further out generates what that range needs.
  assert.ok(await materialize(pool, REF, "2027-01-31") > 0);

  // A new media list replaces template media on untouched posts; media added by hand stays.
  await createMedia(pool, items[1].id, { description: "Hand-added quote card", type: "graphic" });
  const upd = await updateRecurrence(pool, r.value.id, {
    mediaTemplate: [{ description: "Choir clip", type: "video", offsetDays: -2, assigneeEmail: "" }],
  }, REF);
  assert.ok(upd.ok);
  const now = (await listMedia(pool, { contentItemId: items[1].id })).map((m) => m.description).sort();
  assert.deepEqual(now, ["Choir clip", "Hand-added quote card"]);
});

test("one-off edits detach; series edits reach only untouched later posts", async () => {
  const r = await createRecurrence(pool, { title: "Weekly verse", rule: weekly([5]) }, "me@x.org", REF);
  assert.ok(r.ok);
  const [first, second, third, fourth] = await occ(r.value.id);

  await updateContent(pool, second.id, { title: "Verse — Thanksgiving edition" });
  await updateContent(pool, fourth.id, { status: "drafted", caption: "done" });
  await updateContent(pool, third.id, { brief: "Lead with the verse" }, "future");

  const after = await occ(r.value.id);
  const byId = Object.fromEntries(after.map((x) => [x.id, x]));
  assert.equal(byId[second.id].detached, true);
  assert.equal(byId[first.id].brief, "", "earlier posts untouched by a 'this and future' edit");
  assert.equal(byId[third.id].brief, "Lead with the verse");
  assert.equal(byId[fourth.id].brief, "", "drafted posts are left alone");
  assert.equal(after[5].brief, "Lead with the verse", "later untouched posts follow");

  const upd = await updateRecurrence(pool, r.value.id, { title: "Friday verse" }, REF);
  assert.ok(upd.ok);
  const renamed = Object.fromEntries((await occ(r.value.id)).map((x) => [x.id, x]));
  assert.equal(renamed[first.id].title, "Friday verse");
  assert.equal(renamed[second.id].title, "Verse — Thanksgiving edition", "detached keeps its own title");
});

test("skipping a date sticks; changing the rule moves untouched posts only", async () => {
  const r = await createRecurrence(pool, { title: "Prayer prompt", rule: weekly([3]) }, "me@x.org", REF);
  assert.ok(r.ok);
  const [first, second] = await occ(r.value.id);
  const skipped = await deleteContent(pool, first.id);
  assert.ok(skipped.ok);
  assert.equal(skipped.value.skipped, true);
  await materialize(pool, REF, "2026-12-27");
  const again = await occ(r.value.id);
  assert.equal(again.find((x) => x.id === first.id)?.status, "cancelled", "not regenerated");

  await updateContent(pool, second.id, { status: "drafted", caption: "keep me" });
  const moved = await updateRecurrence(pool, r.value.id, { rule: weekly([4]) }, REF);
  assert.ok(moved.ok);
  const rows = await occ(r.value.id);
  const dows = rows.filter((x) => x.status === "idea").map((x) => new Date(x.publish_date + "T12:00:00Z").getUTCDay());
  assert.ok(dows.length && dows.every((d) => d === 4), "untouched posts now on Thursdays");
  assert.ok(rows.some((x) => x.id === second.id), "the drafted Wednesday stays");

  await updateRecurrence(pool, r.value.id, { active: false }, REF);
  assert.equal((await occ(r.value.id)).filter((x) => x.status === "idea").length, 0, "pausing clears untouched slots");

  const ended = await deleteRecurrence(pool, r.value.id, REF);
  assert.ok(ended.ok);
  const kept = await pool.query("SELECT recurrence_id FROM content_items WHERE id = $1", [second.id]);
  assert.equal(kept.rows[0].recurrence_id, null, "worked-on posts outlive the series");
});

test("weekly runs are recurring posts in their own events", async () => {
  // This test seeds them; later tests (the image rule, the migration) rely on it.
  assert.equal(await seedRunRecurrences(pool, REF), 3);
  assert.equal(await seedRunRecurrences(pool, REF), 0, "seeded once");
  const recs = (await pool.query("SELECT draft_key, event_id FROM recurrences WHERE draft_key <> '' ORDER BY draft_key")).rows;
  assert.deepEqual(recs, [
    { draft_key: "friday", event_id: "run-friday" },
    { draft_key: "saturday", event_id: "run-sunday" },
    { draft_key: "wednesday", event_id: "run-wednesday" },
  ]);
});

test("a Metricool send marks the post Scheduled at the booked time", async () => {
  const p = await createContent(pool, { title: "Send me", publishDate: "2026-11-04", platforms: ["facebook"] }, "me@x.org");
  assert.ok(p.ok);
  await markSentToMetricool(pool, p.value.id, "2026-11-04T10:30:00");
  const after = await getContent(pool, p.value.id);
  assert.ok(after.ok);
  assert.equal(after.value.item.status, "scheduled");
  assert.equal(after.value.item.publishTime, "10:30");
});

test("duplicating an event shifts every date and starts the copies over", async () => {
  const camp = await createEvent(pool, { name: "VBS 2026", kind: "event", startDate: "2026-07-06", endDate: "2026-07-10" });
  const p = await createContent(pool, { title: "VBS day 1", publishDate: "2026-07-06", eventId: camp.id, brief: "Recap" }, "me@x.org");
  assert.ok(p.ok);
  await createMedia(pool, p.value.id, { description: "Opening photo", gatherDate: "2026-07-06" });
  await updateContent(pool, p.value.id, { status: "published" });
  const dup = await duplicateEvent(pool, camp.id, { name: "VBS 2027", startDate: "2027-07-05" }, "me@x.org");
  assert.ok(dup.ok);
  assert.equal(dup.value.event.startDate, "2027-07-05");
  assert.equal(dup.value.event.endDate, "2027-07-09");
  const copy = await getEvent(pool, dup.value.event.id);
  assert.ok(copy.ok);
  assert.deepEqual(copy.value.items.map((i) => [i.publishDate, i.status]), [["2027-07-05", "planned"]]);
  assert.deepEqual(copy.value.media.map((m) => [m.gatherDate, m.status]), [["2027-07-05", "scheduled"]]);
  assert.ok(!(await duplicateEvent(pool, camp.id, { name: "" }, "me@x.org")).ok);
});

test("Instagram needs an image: text-only posts can't go there", async () => {
  const bad = await createContent(pool, { title: "Prayer list", publishDate: "2026-11-05", platforms: ["instagram", "facebook"], noMediaNeeded: true }, "me@x.org");
  assert.ok(!bad.ok);
  assert.match(bad.error, /Instagram can't take a text-only post/);
  const ok = await createContent(pool, { title: "Prayer list", publishDate: "2026-11-05", platforms: ["facebook"], noMediaNeeded: true }, "me@x.org");
  assert.ok(ok.ok);
  const sneak = await updateContent(pool, ok.value.id, { platforms: ["facebook", "instagram"] });
  assert.ok(!sneak.ok, "adding Instagram to a text-only post is refused too");
  const rec = await createRecurrence(pool, { title: "Verse", noMediaNeeded: true, platforms: ["instagram"], rule: weekly([2]) }, "me@x.org", REF);
  assert.ok(!rec.ok);
});

test("posts saved before the rule are fixed once: runs gain an image, others lose Instagram", async () => {
  const run = await pool.query("SELECT id FROM recurrences WHERE draft_key = 'friday'");
  await pool.query("UPDATE recurrences SET no_media_needed = true, media_template = '[]' WHERE id = $1", [run.rows[0].id]);
  await pool.query("UPDATE content_items SET no_media_needed = true WHERE recurrence_id = $1", [run.rows[0].id]);
  const old = await pool.query(
    `INSERT INTO content_items (title, platforms, publish_date, no_media_needed) VALUES ('Old text post', '{instagram,facebook}', '2026-11-20', true) RETURNING id`);
  const fixed = await applyImageRule(pool, REF);
  assert.equal(fixed.runs, 1);
  const slot = (await occ(run.rows[0].id))[0];
  assert.equal(slot.no_media_needed, false);
  assert.deepEqual((await listMedia(pool, { contentItemId: slot.id })).map((m) => m.description), ["Image for the post"]);
  const other = await pool.query("SELECT platforms FROM content_items WHERE id = $1", [old.rows[0].id]);
  assert.deepEqual(other.rows[0].platforms, ["facebook"]);
});

test("separate captions per platform round-trip and warn when X runs long", async () => {
  const p = await createContent(pool, { title: "Advent", publishDate: "2026-11-29", platforms: ["instagram", "facebook", "x"] }, "me@x.org");
  assert.ok(p.ok);
  const long = "Join us ".repeat(40);
  const r = await updateContent(pool, p.value.id, {
    captionMode: "separate", captions: { instagram: "IG text", facebook: "FB text https://grmc.org/advent", x: long },
  });
  assert.ok(r.ok);
  assert.equal(r.value.item.captionMode, "separate");
  assert.equal(r.value.item.captions.facebook, "FB text https://grmc.org/advent");
  assert.ok(r.value.warnings.some((w) => /^X caption is \d+ characters; the limit is 280/.test(w)));
});

test("media: collected without a file, and an approved file makes it final", async () => {
  const p = await createContent(pool, { title: "Harvest", publishDate: "2026-11-22" }, "me@x.org");
  assert.ok(p.ok);
  const m = await createMedia(pool, p.value.id, { description: "Choir photo", gatherDate: "2026-11-21" });
  assert.ok(m.ok);
  const collected = await updateMedia(pool, m.value.media.id, { status: "captured" });
  assert.ok(collected.ok);
  assert.equal(collected.value.media.status, "captured", "no link needed");
  const approved = await updateMedia(pool, m.value.media.id, { approvalId: 42, approvalTitle: "Harvest graphic v2" });
  assert.ok(approved.ok);
  assert.equal(approved.value.media.status, "edited");
  assert.equal(approved.value.media.approvalId, 42);
  const cleared = await updateMedia(pool, m.value.media.id, { approvalId: null, approvalTitle: "" });
  assert.ok(cleared.ok);
  assert.equal(cleared.value.media.status, "captured", "removing the file leaves it collected");
});

test("an existing post can start a series on its own date", async () => {
  const p = await createContent(pool, { title: "Prayer Monday", publishDate: "2026-11-02", platforms: ["facebook"] }, "me@x.org");
  assert.ok(p.ok);
  const wrong = await createRecurrence(pool, { title: "Prayer Monday", rule: weekly([1], { startDate: "2026-11-09" }) }, "me@x.org", REF, "", p.value.id);
  assert.ok(!wrong.ok);
  const r = await createRecurrence(pool, { title: "Prayer Monday", platforms: ["facebook"], rule: weekly([1], { startDate: "2026-11-02" }) }, "me@x.org", REF, "", p.value.id);
  assert.ok(r.ok);
  const rows = await occ(r.value.id);
  assert.equal(rows[0].id, p.value.id, "the post is occurrence one, not a twin");
  assert.equal(rows.filter((x) => x.publish_date === "2026-11-02").length, 1);
});


test("profiles and overrides are stored, and a recurrence's override reaches its posts", async () => {
  const ev = await createEvent(pool, { name: "Newsletter", kind: "department" });
  const upd = await updateEvent(pool, ev.id, { drafting: { source: { kind: "mailchimp", subjectContains: "youth news", cutoff: "postDate" }, instructions: "Tease it." } });
  assert.ok(upd.ok);
  assert.deepEqual(upd.value.drafting.source, { kind: "mailchimp", subjectContains: "youth news", cutoff: "postDate" });

  const post = await createContent(pool, { title: "Youth news", publishDate: "2026-11-06", eventId: ev.id, platforms: ["facebook"],
    drafting: { instructions: "Just this one." }, sourceRef: { kind: "manual", content: "Pasted" }, phase: "Part 1" }, "me@x.org");
  assert.ok(post.ok);
  assert.equal(post.value.drafting.instructions, "Just this one.");
  assert.equal(post.value.sourceRef?.kind, "manual");
  assert.equal(post.value.phase, "Part 1");

  const r = await createRecurrence(pool, { title: "Saturday invite", platforms: ["facebook"], drafting: { instructions: "Invite." }, rule: weekly([6]) }, "me@x.org", REF);
  assert.ok(r.ok);
  const first = (await occ(r.value.id))[0];
  assert.deepEqual(first.drafting, { instructions: "Invite." }, "copied onto each occurrence");
  await updateRecurrence(pool, r.value.id, { drafting: { instructions: "Invite warmly." } }, REF);
  assert.deepEqual((await occ(r.value.id))[0].drafting, { instructions: "Invite warmly." }, "series edits reach untouched posts");
});

// Stands in for Mailchimp, Buzzsprout and Anthropic in database tests.
function stubFetch(routes: Array<[RegExp, (url: string, init?: any) => unknown]>) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: any) => {
    const u = String(url);
    calls.push(u);
    const route = routes.find(([re]) => re.test(u));
    if (!route) throw new Error("Unexpected fetch: " + u);
    const body = route[1](u, init);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const CAMPAIGNS = { campaigns: [
  { id: "c25", status: "save", settings: { subject_line: "Grace Notes - October 25, 2026" }, archive_url: "https://mc/c25", send_time: "", create_time: "2026-10-23T14:00:00Z" },
  { id: "c18", status: "sent", settings: { subject_line: "Grace Notes - October 18, 2026" }, archive_url: "https://mc/c18", send_time: "2026-10-16T14:00:00Z", create_time: "2026-10-16T13:00:00Z" },
  { id: "b1", status: "sent", settings: { subject_line: "Weekly Blog - Oct 16" }, archive_url: "https://mc/b1", send_time: "2026-10-16T14:00:00Z", create_time: "2026-10-16T13:00:00Z" },
] };

test("a Mailchimp source picks the issue for the post's week, and a pinned ref wins", async () => {
  const { resolveSource } = await import("./pipeline/sources");
  await pool.query("INSERT INTO settings (key, value) VALUES ('mailchimp_api_key','k'), ('mailchimp_server','us1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const f = stubFetch([
    [/\/campaigns\?/, () => CAMPAIGNS],
    [/\/campaigns\/(\w+)\/content/, (u) => ({ plain_text: "Text of " + /campaigns\/(\w+)\//.exec(u)![1] })],
  ]);
  try {
    const gn = { kind: "mailchimp" as const, subjectContains: "grace notes", cutoff: "followingSunday" as const };
    const wk = await resolveSource(pool, gn, null, "2026-10-14");
    assert.equal(wk?.id, "c18");
    assert.equal(wk?.content, "Text of c18");
    const next = await resolveSource(pool, gn, null, "2026-10-21");
    assert.equal(next?.id, "c25");
    assert.equal(next?.isDraft, true, "an unsent issue is marked");
    const pinned = await resolveSource(pool, gn, { kind: "mailchimp", id: "c18", title: "Grace Notes - October 18, 2026" }, "2026-10-21");
    assert.equal(pinned?.id, "c18", "the post keeps the issue it was drafted from");
    const undated = await resolveSource(pool, gn, null, null);
    assert.equal(undated?.id, "c25", "no publish date: newest");
    assert.equal(await resolveSource(pool, { kind: "buzzsprout" }, null, "2026-10-21"), null, "no episode picked yet");
    const manual = await resolveSource(pool, gn, { kind: "manual", content: "Pasted", url: "https://p" }, "2026-10-21");
    assert.equal(manual?.content, "Pasted");
  } finally {
    f.restore();
    await pool.query("DELETE FROM settings WHERE key IN ('mailchimp_api_key','mailchimp_server')");
  }
});

const anthropicReply = (obj: unknown) => ({ content: [{ text: JSON.stringify(obj) }] });

async function withKeys<T>(fn: () => Promise<T>): Promise<T> {
  await pool.query(`INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t'), ('mailchimp_api_key','k'), ('mailchimp_server','us1')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  try { return await fn(); }
  finally { await pool.query("DELETE FROM settings WHERE key IN ('anthropic_api_key','mailchimp_api_key','mailchimp_server')"); }
}

test("Draft with Claude drafts a Grace Notes post from that week's issue, and logs it", async () => {
  const { draftAndSave } = await import("./pipeline/caption");
  const { listDraftHistory } = await import("./pipeline/history");
  const { GRACE_NOTES_PROFILE } = await import("./pipeline/drafting-seed");
  const ev = await createEvent(pool, { name: "GN test", kind: "series" });
  await updateEvent(pool, ev.id, { drafting: GRACE_NOTES_PROFILE });
  const post = await createContent(pool, { title: "Grace Notes", publishDate: "2026-10-14", eventId: ev.id, platforms: ["facebook"] }, "me@x.org");
  assert.ok(post.ok);
  const prompts: string[] = [];
  const f = stubFetch([
    [/\/campaigns\?/, () => CAMPAIGNS],
    [/\/campaigns\/(\w+)\/content/, (u) => ({ plain_text: "Text of " + /campaigns\/(\w+)\//.exec(u)![1] })],
    [/api\.anthropic\.com/, (_u, init) => { prompts.push(JSON.parse(init.body).messages[0].content); return anthropicReply({ post: "This week in Grace Notes…" }); }],
  ]);
  try {
    const r = await withKeys(() => draftAndSave(pool, post.value.id, "me@x.org"));
    assert.ok(r.ok);
    assert.equal(r.value.caption, "This week in Grace Notes…");
    assert.equal(r.value.status, "drafted");
    assert.equal(r.value.sourceRef?.id, "c18", "remembers the issue it drafted from");
    assert.ok(prompts[0].includes(GRACE_NOTES_PROFILE.instructions!), "the Wednesday instructions, word for word");
    assert.match(prompts[0], /Text of c18/);
    assert.equal((await listDraftHistory(pool, post.value.id)).length, 1);

    // The event's profile changes; the drafted post keeps its issue.
    await updateEvent(pool, ev.id, { drafting: { ...GRACE_NOTES_PROFILE, source: { kind: "mailchimp", subjectContains: "grace notes", cutoff: "latest" } } });
    await withKeys(() => draftAndSave(pool, post.value.id, "me@x.org"));
    assert.match(prompts[1], /Text of c18/);
    assert.equal((await listDraftHistory(pool, post.value.id)).length, 2);
  } finally { f.restore(); }
});

test("drafting without Mailchimp set up still works from pasted content", async () => {
  const { draftCaptions, parseDraftRequest, resolveForDraft } = await import("./pipeline/caption");
  const { GRACE_NOTES_PROFILE } = await import("./pipeline/drafting-seed");
  const ev = await createEvent(pool, { name: "GN no keys", kind: "series" });
  await updateEvent(pool, ev.id, { drafting: GRACE_NOTES_PROFILE });
  const req = parseDraftRequest({ title: "Grace Notes", eventId: ev.id, platforms: ["facebook"], publishDate: "2026-10-14" });
  assert.ok(req.ok);
  await assert.rejects(() => resolveForDraft(pool, req.value), /Mailchimp credentials not configured/);
  const pasted = parseDraftRequest({ title: "Grace Notes", eventId: ev.id, platforms: ["facebook"], publishDate: "2026-10-14",
    sourceRef: { kind: "manual", content: "Pasted issue text", url: "https://mc/x" } });
  assert.ok(pasted.ok);
  await pool.query("INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const f = stubFetch([[/api\.anthropic\.com/, () => anthropicReply({ post: "From the paste" })]]);
  try {
    const r = await draftCaptions(pool, pasted.value, "me@x.org");
    assert.ok(r.ok);
    assert.equal(r.value.caption, "From the paste");
  } finally { f.restore(); await pool.query("DELETE FROM settings WHERE key = 'anthropic_api_key'"); }
});

test("a bad reply from Claude saves nothing, and Draft all carries on past it", async () => {
  const { draftAll } = await import("./pipeline/caption");
  const a = await createContent(pool, { title: "A", publishDate: "2026-11-02", platforms: ["facebook"], caption: "keep me" }, "me@x.org");
  const b = await createContent(pool, { title: "B", publishDate: "2026-11-03", platforms: ["facebook", "x"], captionMode: "separate" }, "me@x.org");
  const c = await createContent(pool, { title: "C", publishDate: "2026-11-04", platforms: ["facebook"] }, "me@x.org");
  assert.ok(a.ok && b.ok && c.ok);
  const replies = ["not json at all", JSON.stringify({ facebook: "FB only" }), JSON.stringify({ post: "C drafted" })];
  await pool.query("INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const f = stubFetch([[/api\.anthropic\.com/, () => ({ content: [{ text: replies.shift() }] })]]);
  try {
    const results = await draftAll(pool, [a.value.id, b.value.id, c.value.id], "me@x.org");
    assert.deepEqual(results.map((r) => r.ok), [false, false, true]);
    assert.match(results[0].error!, /wasn't readable/);
    assert.match(results[1].error!, /didn't write the X caption/);
    assert.equal((await getContent(pool, a.value.id)).ok && (await pool.query("SELECT caption FROM content_items WHERE id=$1", [a.value.id])).rows[0].caption, "keep me");
  } finally { f.restore(); await pool.query("DELETE FROM settings WHERE key = 'anthropic_api_key'"); }
});

test("a podcast post can't draft until its episode is picked", async () => {
  const { draftCaptions, parseDraftRequest } = await import("./pipeline/caption");
  const ev = await createEvent(pool, { name: "Pod test", kind: "series" });
  await updateEvent(pool, ev.id, { drafting: { source: { kind: "buzzsprout" } } });
  const req = parseDraftRequest({ title: "Episode post", eventId: ev.id, platforms: ["facebook"], publishDate: "2026-11-02" });
  assert.ok(req.ok);
  const r = await draftCaptions(pool, req.value, "me@x.org");
  assert.ok(!r.ok);
  assert.match(r.error, /Pick the episode this post is about/);
});

test("planning from an episode makes one pinned post per angle, on its offset day", async () => {
  const { planFromEpisode } = await import("./pipeline/planning");
  const { PODCAST_PROFILE } = await import("./pipeline/drafting-seed");
  const ev = await createEvent(pool, { name: "Pod plan", kind: "series" });
  await updateEvent(pool, ev.id, { drafting: PODCAST_PROFILE });
  await pool.query(`INSERT INTO settings (key, value) VALUES ('buzzsprout_api_token','t'), ('buzzsprout_podcast_id','77')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const episode = (id: number, published_at: string) => ({ id, title: "Too small or too big?", description: "<p>Notes</p>", custom_url: null,
    published_at, duration: 1920, episode_number: 4, season_number: 1, private: false });
  const f = stubFetch([[/buzzsprout\.com\/api\/77\/episodes\/(\d+)\.json/, (u) => /episodes\/9\./.test(u) ? episode(9, "2026-11-01T10:00:00Z") : episode(10, "")]]);
  try {
    const r = await planFromEpisode(pool, ev.id, "9", ["announcement", "quote"], "me@x.org", REF);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((i) => [i.title, i.publishDate]), [
      ["Announcement: Too small or too big?", "2026-11-01"], ["Pull quote: Too small or too big?", "2026-11-05"],
    ]);
    assert.equal(r.value[1].drafting.instructions, PODCAST_PROFILE.angles!.find((a) => a.key === "quote")!.instructions);
    assert.deepEqual([r.value[0].sourceRef?.kind, r.value[0].sourceRef?.id], ["buzzsprout", "9"]);

    const undated = await planFromEpisode(pool, ev.id, "10", ["guest"], "me@x.org", REF);
    assert.ok(undated.ok);
    assert.equal(undated.value[0].publishDate, "2026-11-02", "no episode date: today + offset");

    assert.ok(!(await planFromEpisode(pool, ev.id, "9", [], "me@x.org", REF)).ok, "needs an angle");
    const plain = await createEvent(pool, { name: "No source" });
    const wrong = await planFromEpisode(pool, plain.id, "9", ["announcement"], "me@x.org", REF);
    assert.ok(!wrong.ok);
    assert.match(wrong.error, /source isn't Buzzsprout/);
  } finally {
    f.restore();
    await pool.query("DELETE FROM settings WHERE key IN ('buzzsprout_api_token','buzzsprout_podcast_id')");
  }
});

test("a series is planned with Claude, edited, then saved as posts", async () => {
  const { proposeSeriesPlan, saveSeriesPlan } = await import("./pipeline/planning");
  const ev = await createEvent(pool, { name: "Advent 2026", kind: "series", notes: "Four weeks of hope." });
  await pool.query("INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  let prompt = "";
  const f = stubFetch([[/api\.anthropic\.com/, (_u, init) => {
    prompt = JSON.parse(init.body).messages[0].content;
    return { content: [{ text: JSON.stringify([
      { date: "2026-11-29", phase: "Waiting", title: "Hope", sub: "Light the first candle." },
      { date: "Dec 6", phase: "", title: "Peace", sub: "Second candle." },
    ]) }] };
  }]]);
  try {
    const p = await proposeSeriesPlan(pool, ev.id, { count: 2, cadence: "weekly", startDate: "2026-11-29" });
    assert.ok(p.ok);
    assert.match(prompt, /Generate a post schedule for a social media series called "Advent 2026"/);
    assert.match(prompt, /Context: Four weeks of hope\./);
    assert.deepEqual(p.value.map((x) => x.date), ["2026-11-29", ""], "a date Claude didn't format is left for the person to fill");
    assert.ok(!(await saveSeriesPlan(pool, ev.id, p.value, "me@x.org")).ok, "every post needs a date before saving");
    const saved = await saveSeriesPlan(pool, ev.id, [p.value[0], { ...p.value[1], date: "2026-12-06" }], "me@x.org");
    assert.ok(saved.ok);
    assert.deepEqual(saved.value.map((i) => [i.title, i.publishDate, i.brief, i.phase, i.eventId]), [
      ["Hope", "2026-11-29", "Light the first candle.", "Waiting", ev.id],
      ["Peace", "2026-12-06", "Second candle.", "", ev.id],
    ]);
  } finally { f.restore(); await pool.query("DELETE FROM settings WHERE key = 'anthropic_api_key'"); }
});

test("the drafting migration seeds run profiles, splits out Sunday worship, and runs once", async () => {
  const { migrateDrafting, DRAFTING_SETTING } = await import("./pipeline/migrate-drafting");
  const { GRACE_NOTES_PROFILE, SUNDAY_PROFILE, SERIES_INSTRUCTIONS } = await import("./pipeline/drafting-seed");
  // Rebuild the pre-migration state: run profiles empty, the Saturday invite under Grace Notes.
  await pool.query("DELETE FROM settings WHERE key IN ($1, 'house_voice')", [DRAFTING_SETTING]);
  await pool.query("UPDATE events SET drafting = '{}', name = 'Grace Notes & Sunday invite' WHERE id = 'run-wednesday'");
  await pool.query("UPDATE events SET drafting = '{}' WHERE id LIKE 'run-%'");
  const sat = (await pool.query("SELECT id FROM recurrences WHERE draft_key = 'saturday'")).rows[0].id;
  await pool.query("UPDATE recurrences SET event_id = 'run-wednesday' WHERE id = $1", [sat]);
  await pool.query("UPDATE content_items SET event_id = 'run-wednesday' WHERE recurrence_id = $1", [sat]);
  const drafted = (await occ(sat))[0];
  await pool.query("UPDATE content_items SET status = 'drafted' WHERE id = $1", [drafted.id]);
  await pool.query(`INSERT INTO series (id, name, context) VALUES ('s-mig', 'Lent', 'Forty days of prayer.') ON CONFLICT DO NOTHING`);
  const lent = await pool.query(`INSERT INTO events (name, kind, series_id, notes) VALUES ('Lent', 'series', 's-mig', 'Ashes to Easter.') RETURNING id`);

  const r = await migrateDrafting(pool, REF);
  assert.equal(r.ran, true);
  const gn = (await pool.query("SELECT name, drafting FROM events WHERE id = 'run-wednesday'")).rows[0];
  assert.equal(gn.name, "Grace Notes");
  assert.deepEqual(gn.drafting, GRACE_NOTES_PROFILE);
  assert.deepEqual((await pool.query("SELECT drafting FROM events WHERE id = 'run-sunday'")).rows[0].drafting, SUNDAY_PROFILE);
  assert.equal((await pool.query("SELECT event_id FROM recurrences WHERE id = $1", [sat])).rows[0].event_id, "run-sunday");
  const after = await occ(sat);
  assert.equal(after.find((x) => x.id === drafted.id)!.event_id, "run-wednesday", "a drafted Saturday post stays put");
  assert.ok(after.filter((x) => x.id !== drafted.id).every((x) => x.event_id === "run-sunday"), "untouched ones move");
  const lentNow = (await pool.query("SELECT notes, drafting FROM events WHERE id = $1", [lent.rows[0].id])).rows[0];
  assert.equal(lentNow.notes, "Ashes to Easter.\n\nForty days of prayer.");
  assert.equal(lentNow.drafting.instructions, SERIES_INSTRUCTIONS);
  assert.ok((await pool.query("SELECT value FROM settings WHERE key = 'house_voice'")).rows[0].value.startsWith("GRMC voice rules"));

  assert.equal((await migrateDrafting(pool, REF)).ran, false, "once only");
});

// ── Final review fixes ──

test("Draft all carries on when a post throws partway (e.g. the X shorten call fails)", async () => {
  const { draftAll } = await import("./pipeline/caption");
  const a = await createContent(pool, { title: "Long X", publishDate: "2026-11-10", platforms: ["facebook", "x"] }, "me@x.org");
  const b = await createContent(pool, { title: "Null reply", publishDate: "2026-11-11", platforms: ["facebook"] }, "me@x.org");
  const c = await createContent(pool, { title: "Fine", publishDate: "2026-11-12", platforms: ["facebook"] }, "me@x.org");
  assert.ok(a.ok && b.ok && c.ok);
  const replies: Array<() => unknown> = [
    () => ({ content: [{ text: JSON.stringify({ post: "Too long ".repeat(50) }) }] }),
    () => { throw new Error("429 Too Many Requests"); },
    () => ({ content: [{ text: "null" }] }),
    () => ({ content: [{ text: JSON.stringify({ post: "C drafted" }) }] }),
  ];
  await pool.query("INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const f = stubFetch([[/api\.anthropic\.com/, () => replies.shift()!()]]);
  try {
    const results = await draftAll(pool, [a.value.id, b.value.id, c.value.id], "me@x.org");
    assert.deepEqual(results.map((r) => r.ok), [false, false, true], "every post gets an answer");
    assert.match(results[0].error!, /429/);
    assert.match(results[1].error!, /without a draft|wasn't readable/);
  } finally { f.restore(); await pool.query("DELETE FROM settings WHERE key = 'anthropic_api_key'"); }
});

test("a post that turns its source off doesn't use a stored issue", async () => {
  const { resolveSource } = await import("./pipeline/sources");
  const r = await resolveSource(pool, { kind: "none" }, { kind: "mailchimp", id: "c18", title: "Grace Notes" }, "2026-10-21");
  assert.equal(r, null);
});

test("a Mailchimp error says so instead of reading as 'no campaigns'", async () => {
  const { resolveSource } = await import("./pipeline/sources");
  await pool.query("INSERT INTO settings (key, value) VALUES ('mailchimp_api_key','k'), ('mailchimp_server','us1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({ title: "API Key Invalid", detail: "Your API key may be invalid." }) })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => resolveSource(pool, { kind: "mailchimp", subjectContains: "grace notes", cutoff: "latest" }, null, "2026-10-21"),
      /Mailchimp answered 401: API Key Invalid/);
  } finally {
    globalThis.fetch = real;
    await pool.query("DELETE FROM settings WHERE key IN ('mailchimp_api_key','mailchimp_server')");
  }
});

test("re-saving a recurring post's unchanged override doesn't detach it", async () => {
  const r = await createRecurrence(pool, { title: "Keyorder", platforms: ["facebook"], rule: weekly([2]) }, "me@x.org", REF);
  assert.ok(r.ok);
  const first = (await occ(r.value.id))[0];
  // As stored by jsonb (keys reordered) …
  await pool.query(`UPDATE content_items SET drafting = '{"source": {"kind": "none"}, "instructions": "Short."}' WHERE id = $1`, [first.id]);
  // … and as the editor sends it back (another key order), alongside a real status change.
  const u = await updateContent(pool, first.id, { drafting: { instructions: "Short.", source: { kind: "none" } }, status: "drafted" });
  assert.ok(u.ok);
  assert.equal((await pool.query("SELECT detached FROM content_items WHERE id = $1", [first.id])).rows[0].detached, false);
});

test("weekly-run posts aren't told they're post N of a series", async () => {
  const { draftCaptions, parseDraftRequest } = await import("./pipeline/caption");
  const post = await createContent(pool, { title: "Grace Notes", publishDate: "2026-10-28", eventId: "run-wednesday", platforms: ["facebook"],
    sourceRef: { kind: "manual", content: "Issue text" } }, "me@x.org");
  assert.ok(post.ok);
  const req = parseDraftRequest({ contentItemId: post.value.id, title: "Grace Notes", eventId: "run-wednesday", platforms: ["facebook"],
    publishDate: "2026-10-28", sourceRef: { kind: "manual", content: "Issue text" } });
  assert.ok(req.ok);
  let prompt = "";
  await pool.query("INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const f = stubFetch([[/api\.anthropic\.com/, (_u, init) => { prompt = JSON.parse(init.body).messages[0].content; return anthropicReply({ post: "ok" }); }]]);
  try {
    assert.ok((await draftCaptions(pool, req.value, "me@x.org")).ok);
    assert.doesNotMatch(prompt, /THIS POST: \d+ of \d+/);
  } finally { f.restore(); await pool.query("DELETE FROM settings WHERE key = 'anthropic_api_key'"); }
});

test("an uploaded file is stored in R2 and attaches to media as its final file", async () => {
  const { storeUpload } = await import("./pipeline/uploads");
  const puts: string[] = [];
  const fakePut = async (_c: unknown, bytes: Buffer, type: string, seed: string, prefix: string) => {
    puts.push(`${prefix}:${type}:${bytes.length}`);
    return `https://media.example/${prefix}/${seed}.jpg`;
  };
  await assert.rejects(() => storeUpload(pool, Buffer.from("x"), "image/jpeg", "a.jpg", fakePut), /Image hosting \(R2\) not configured/);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('r2_account_id','a'), ('r2_access_key_id','k'), ('r2_secret_access_key','s'),
                    ('r2_bucket','b'), ('r2_public_base_url','https://media.example') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  try {
    await assert.rejects(() => storeUpload(pool, Buffer.from("x"), "text/plain", "a.txt", fakePut), /a photo .* or a video/);
    const up = await storeUpload(pool, Buffer.from("jpegbytes"), "image/jpeg", "Choir.jpg", fakePut);
    assert.deepEqual(puts, ["media:image/jpeg:9"]);
    assert.equal(up.name, "Choir.jpg");
    assert.equal(up.type, "image");
    assert.match(up.url, /^https:\/\/media\.example\/media\//);

    const p = await createContent(pool, { title: "Upload test", publishDate: "2026-11-20", platforms: ["facebook"] }, "me@x.org");
    assert.ok(p.ok);
    const m = await createMedia(pool, p.value.id, { description: "Choir photo" });
    assert.ok(m.ok);
    const withFile = await updateMedia(pool, m.value.media.id, { fileLink: up.url, fileName: up.name, fileType: up.type });
    assert.ok(withFile.ok);
    assert.equal(withFile.value.media.status, "edited", "a file attached means it's final");
    assert.deepEqual([withFile.value.media.fileName, withFile.value.media.fileType], ["Choir.jpg", "image"]);
    const removed = await updateMedia(pool, m.value.media.id, { fileLink: "", fileName: "", fileType: "" });
    assert.ok(removed.ok);
    assert.equal(removed.value.media.status, "captured", "removing the file leaves it collected");
  } finally {
    await pool.query("DELETE FROM settings WHERE key LIKE 'r2_%'");
  }
});

// ── The post's Media field: attachments, apart from things to collect ──

test("an attachment is final media, but never a capture to-do", async () => {
  const p = await createContent(pool, { title: "Attach only", publishDate: "2026-11-24", platforms: ["instagram"] }, "me@x.org");
  assert.ok(p.ok);
  const bad = await createMedia(pool, p.value.id, { kind: "attachment" });
  assert.ok(!bad.ok, "an attachment needs its file");
  const a = await createMedia(pool, p.value.id, { kind: "attachment", approvalId: 12, approvalTitle: "Kids Camp banner" });
  assert.ok(a.ok);
  assert.equal(a.value.media.status, "edited");
  assert.equal(a.value.media.kind, "attachment");
  assert.equal(a.value.media.description, "Kids Camp banner", "named after its file");
  const b = await createMedia(pool, p.value.id, { kind: "attachment", fileLink: "https://media.example/media/x.jpg", fileName: "x.jpg", fileType: "image" });
  assert.ok(b.ok);
  assert.ok(b.value.media.position > a.value.media.position, "added to the end");

  assert.ok(!(await listMedia(pool, {})).some((m) => m.contentItemId === p.value.id), "not on capture calendars, My work or gaps");
  assert.equal((await listMedia(pool, { contentItemId: p.value.id })).length, 2, "but part of the post");
  const row = (await listContent(pool, { ids: [p.value.id] }))[0];
  assert.deepEqual([row.mediaTotal, row.attachmentCount], [0, 2]);
  const { gaps } = await dashboardGaps(pool, REF);
  assert.ok(!gaps.find((g) => g.key === "no-media")!.ids.includes(p.value.id), "attached media counts as media");
  assert.ok((await updateContent(pool, p.value.id, { status: "ready" })).ok, "and can be Ready");
});

test("a recurring post's image is copied to each week, and a week can swap its own", async () => {
  const r = await createRecurrence(pool, { title: "Weekly verse card", platforms: ["instagram", "facebook"], rule: weekly([4]),
    attachments: [{ approvalId: 21, approvalTitle: "Verse card" }] }, "me@x.org", REF);
  assert.ok(r.ok);
  const weeks = await occ(r.value.id);
  const filesOf = async (id: string) => (await listMedia(pool, { contentItemId: id })).map((m) => [m.kind, m.approvalId, m.fileLink].join("|"));
  assert.deepEqual(await filesOf(weeks[0].id), ["attachment|21|"]);
  assert.deepEqual(await filesOf(weeks[3].id), ["attachment|21|"]);

  // Week 2 swaps its image for one of its own.
  const own = (await listMedia(pool, { contentItemId: weeks[1].id }))[0];
  await deleteMedia(pool, own.id);
  await createMedia(pool, weeks[1].id, { kind: "attachment", approvalId: 99, approvalTitle: "Special" });

  const upd = await updateRecurrence(pool, r.value.id, { attachments: [{ approvalId: 22, approvalTitle: "New verse card" }] }, REF);
  assert.ok(upd.ok);
  assert.deepEqual(await filesOf(weeks[0].id), ["attachment|22|"], "untouched weeks follow the series");
  assert.deepEqual(await filesOf(weeks[1].id), ["attachment|99|"], "the swapped week keeps its own");
  const again = (await getRecurrence(pool, r.value.id, REF))!;
  assert.deepEqual(again.attachments.map((x) => x.approvalId), [22]);
});
