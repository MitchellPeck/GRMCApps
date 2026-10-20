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

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const REF = "2026-11-01";

before(async () => {
  await pool.query("DROP TABLE IF EXISTS media_assets, content_items, events");
  await pool.query(SCHEMA_SQL);
  await pool.query("DELETE FROM series_posts");
  await pool.query("DELETE FROM series");
  await pool.query("DELETE FROM post_drafts");
  await pool.query("DELETE FROM settings WHERE key = $1", [BACKFILL_SETTING]);
});

after(async () => {
  await pool.query("DELETE FROM media_assets");
  await pool.query("DELETE FROM content_items");
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
