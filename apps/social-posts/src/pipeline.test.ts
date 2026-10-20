import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { savePostDrafts } from "./drafts";
import { createSeries, getSeriesPosts, updateSeriesPostField, updateSeriesMeta } from "./series";
import {
  createContent, createEvent, createMedia, dashboardGaps, deleteContent, deleteEvent, getContent,
  getEvent, listContent, listMedia, updateContent, updateMedia,
} from "./pipeline/repo";
import { BACKFILL_SETTING, backfillOnce, markSentToMetricool, recordRunDrafts } from "./pipeline/sync";
import { RUN_EVENTS } from "./pipeline/config";
import { createRecurrence, deleteRecurrence, materialize, seedRunRecurrences, updateRecurrence } from "./pipeline/recurring";
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
  assert.equal(runEvents.rowCount, 3);

  const items = await pool.query("SELECT * FROM content_items WHERE series_id = 's-old' ORDER BY post_idx");
  assert.deepEqual(items.rows.map((i) => [i.status, i.publish_date]), [
    ["idea", "2026-11-30"], ["drafted", "2026-12-07"], ["published", "2026-12-14"], ["idea", null],
  ]);
  assert.equal(items.rows[1].caption, "Peace draft");
  assert.equal(items.rows[1].brief, "angle");
});

test("the Series tab reads from, and writes through to, the content item", async () => {
  const before = await getSeriesPosts(pool, "s-old");
  assert.ok(before.ok);
  const peace = before.posts[1];
  assert.ok(peace.contentItemId);

  // A pipeline edit shows up on the Series tab...
  await updateContent(pool, peace.contentItemId, { noMediaNeeded: true, status: "ready", caption: "Peace v2" });
  const viaSeries = await getSeriesPosts(pool, "s-old");
  assert.ok(viaSeries.ok);
  assert.equal(viaSeries.posts[1].status, "drafted", "Ready shows as drafted to the Series tab");
  assert.equal(viaSeries.posts[1].draft, "Peace v2");
  const legacy = await pool.query("SELECT status, draft FROM series_posts WHERE series_id='s-old' AND post_idx=1");
  assert.deepEqual(legacy.rows[0], { status: "drafted", draft: "Peace v2" }, "legacy columns kept current");

  // ...re-saying "drafted" from the Series tab doesn't knock Ready backwards...
  await updateSeriesPostField(pool, "s-old", 1, "status", "drafted");
  assert.equal((await getContent(pool, peace.contentItemId)).ok && (await pool.query("SELECT status FROM content_items WHERE id=$1", [peace.contentItemId])).rows[0].status, "ready");

  // ...but "posted" moves it on.
  await updateSeriesPostField(pool, "s-old", 1, "status", "posted");
  const posted = await pool.query("SELECT status FROM content_items WHERE id=$1", [peace.contentItemId]);
  assert.equal(posted.rows[0].status, "published");

  await updateSeriesMeta(pool, "s-old", { name: "Advent 2026" });
  const ev = await pool.query("SELECT name FROM events WHERE series_id='s-old'");
  assert.equal(ev.rows[0].name, "Advent 2026");
});

test("a new series lands in the pipeline straight away", async () => {
  const created = await createSeries(pool, { name: "Kids Camp countdown", posts: [{ date: "Nov 10", title: "Ten days" }] });
  assert.ok(created.ok);
  const posts = await getSeriesPosts(pool, created.id);
  assert.ok(posts.ok);
  assert.ok(posts.posts[0].contentItemId);
  assert.equal(posts.posts[0].scheduleDate.slice(5), "11-10");
});

test("automated runs land as Drafted items and re-runs refresh instead of duplicating", async () => {
  const ids = await savePostDrafts(pool, "wednesday", "2026-11-08", { wednesday: "GN v1", saturday: "Invite v1" }, "me@x.org");
  assert.equal(typeof ids.wednesday, "number");
  const dates = { wednesday: "2026-11-04", saturday: "2026-11-07" };
  const first = await recordRunDrafts(pool, "wednesday", [
    { key: "wednesday", text: "GN v1", date: dates.wednesday, draftId: ids.wednesday, title: "Grace Notes" },
    { key: "saturday", text: "Invite v1", date: dates.saturday, draftId: ids.saturday, title: "Sunday invite" },
  ], "me@x.org");
  const again = await recordRunDrafts(pool, "wednesday", [
    { key: "wednesday", text: "GN v2", date: dates.wednesday, draftId: ids.wednesday, title: "Grace Notes" },
  ], "me@x.org");
  assert.equal(again.wednesday, first.wednesday, "same slot, same item");

  const detail = await getContent(pool, first.wednesday);
  assert.ok(detail.ok);
  assert.equal(detail.value.item.caption, "GN v2");
  assert.equal(detail.value.item.status, "drafted");
  assert.equal(detail.value.item.eventId, RUN_EVENTS.wednesday.id);
  assert.equal(detail.value.source?.kind, "run");

  // Once it has moved past Drafted, a re-run adds a fresh item instead.
  await markSentToMetricool(pool, first.wednesday, "2026-11-04T10:30:00");
  const sent = await getContent(pool, first.wednesday);
  assert.ok(sent.ok);
  assert.equal(sent.value.item.status, "scheduled");
  assert.equal(sent.value.item.publishTime, "10:30");
  const third = await recordRunDrafts(pool, "wednesday", [
    { key: "wednesday", text: "GN v3", date: dates.wednesday, draftId: ids.wednesday, title: "Grace Notes" },
  ], "me@x.org");
  assert.notEqual(third.wednesday, first.wednesday);
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

test("weekly runs become recurrences and fill their own slots", async () => {
  assert.equal(await seedRunRecurrences(pool, REF), 3);
  assert.equal(await seedRunRecurrences(pool, REF), 0, "seeded once");
  const slots = await pool.query(
    `SELECT id, publish_date FROM content_items WHERE event_id = $1 AND draft_key = 'wednesday' AND recurrence_id IS NOT NULL
      ORDER BY publish_date`, [RUN_EVENTS.wednesday.id]);
  // Nov 4 already had a drafted Grace Notes from the earlier run test, so no empty twin.
  assert.equal(slots.rows[0].publish_date, "2026-11-11");
  const ids = await savePostDrafts(pool, "wednesday", "2026-11-15", { wednesday: "GN Nov 11" }, "me@x.org");
  const filled = await recordRunDrafts(pool, "wednesday", [
    { key: "wednesday", text: "GN Nov 11", date: "2026-11-11", draftId: ids.wednesday, title: "Grace Notes: Advent" },
  ], "me@x.org");
  assert.equal(filled.wednesday, slots.rows[0].id, "the run filled the slot instead of adding a post");
  const item = await getContent(pool, filled.wednesday);
  assert.ok(item.ok);
  assert.equal(item.value.item.status, "drafted");
  assert.ok(item.value.recurrence);
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
