import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import {
  createContent, createEvent, createEventMedia, createMedia, deleteEvent, getEvent, listMedia,
  updateContent, updateMedia,
} from "./pipeline/repo";
import { parseMediaInput } from "./pipeline/rules";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

before(async () => {
  // Same rebuild as pipeline.test.ts, plus the Breeze and checklist tables.
  await pool.query("DROP TABLE IF EXISTS gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors, metricool_links, media_assets, content_items, recurrences, events, breeze_series, checklist_rules");
  await pool.query(SCHEMA_SQL);
});

after(async () => {
  await pool.query("DELETE FROM media_assets");
  await pool.query("DELETE FROM content_items");
  await pool.query("DELETE FROM events");
  await pool.end();
});

async function eventWithPost(name: string) {
  const ev = await createEvent(pool, { name, startDate: "2026-12-10" });
  const post = await createContent(pool, { title: name + " post", eventId: ev.id, publishDate: "2026-12-05" }, "t@x");
  assert.ok(post.ok);
  return { ev, post: post.value };
}

test("event-level graphic is created with no post", async () => {
  const ev = await createEvent(pool, { name: "Cover test", startDate: "2026-12-10" });
  const r = await createEventMedia(pool, ev.id, { description: "FB cover", type: "graphic", graphicType: "fb-event-cover", gatherDate: "2026-12-01" });
  assert.ok(r.ok, !r.ok ? r.error : "");
  const m = r.value.media;
  assert.equal(m.contentItemId, null);
  assert.equal(m.eventId, ev.id);
  assert.equal(m.onEvent, true);
  assert.equal(m.status, "scheduled");
  assert.equal(m.graphicType, "fb-event-cover");
  assert.equal(m.kind, "collect");
  assert.equal(m.eventName, "Cover test");
  assert.equal(m.dueEdited, false);
});

test("an event-level graphic needs an event that exists", async () => {
  const r = await createEventMedia(pool, "no-such-event", { description: "x" });
  assert.equal(r.ok, false);
});

test("unknown graphicType is rejected", () => {
  assert.equal(parseMediaInput({ description: "x", graphicType: "poster" }, "create").ok, false);
  const good = parseMediaInput({ description: "x", graphicType: "ig-story" }, "create");
  assert.ok(good.ok);
  assert.equal(good.value.graphicType, "ig-story");
  const cleared = parseMediaInput({ graphicType: null }, "patch");
  assert.ok(cleared.ok);
  assert.equal(cleared.value.graphicType, null);
});

test("listMedia by event includes event-level and post media", async () => {
  const { ev, post } = await eventWithPost("Both kinds");
  await createEventMedia(pool, ev.id, { description: "Slide", graphicType: "announcement-slide" });
  await createMedia(pool, post.id, { description: "Photo" });
  const media = await listMedia(pool, { eventId: ev.id });
  assert.equal(media.length, 2);
  const post1 = media.find((m) => m.description === "Photo")!;
  assert.equal(post1.onEvent, false);
  assert.equal(post1.contentItemId, post.id);
  assert.equal(post1.eventId, ev.id);
});

test("listMedia with no filters still excludes attachments and includes event-level graphics", async () => {
  const { ev, post } = await eventWithPost("No filters");
  const g = await createEventMedia(pool, ev.id, { description: "Story", graphicType: "ig-story" });
  assert.ok(g.ok);
  const att = await createMedia(pool, post.id, { kind: "attachment", fileLink: "https://x/y.png", fileName: "y.png" });
  assert.ok(att.ok);
  const all = await listMedia(pool, {});
  assert.ok(all.some((m) => m.id === g.value.media.id));
  assert.ok(!all.some((m) => m.id === att.value.media.id));
});

test("archived events' graphics drop out of general lists", async () => {
  const ev = await createEvent(pool, { name: "Archived one", archived: true });
  const g = await createEventMedia(pool, ev.id, { description: "Old cover" });
  assert.ok(g.ok);
  assert.ok(!(await listMedia(pool, {})).some((m) => m.id === g.value.media.id));
});

test("listMedia({ contentItemId }) never returns event-level media", async () => {
  const { ev, post } = await eventWithPost("Post only");
  await createEventMedia(pool, ev.id, { description: "Cover" });
  await createMedia(pool, post.id, { description: "Photo" });
  const media = await listMedia(pool, { contentItemId: post.id });
  assert.deepEqual(media.map((m) => m.description), ["Photo"]);
});

test("a row with both or neither owner is refused by the database", async () => {
  const { ev, post } = await eventWithPost("Owner check");
  await assert.rejects(pool.query(
    "INSERT INTO media_assets (content_item_id, event_id, description) VALUES ($1, $2, 'both')", [post.id, ev.id]));
  await assert.rejects(pool.query("INSERT INTO media_assets (description) VALUES ('neither')"));
});

test("editing gatherDate sets due_edited; editing other fields doesn't", async () => {
  const ev = await createEvent(pool, { name: "Due edit" });
  const g = await createEventMedia(pool, ev.id, { description: "Cover", gatherDate: "2026-12-01" });
  assert.ok(g.ok);
  const id = g.value.media.id;
  const notes = await updateMedia(pool, id, { notes: "use the blue one" });
  assert.ok(notes.ok);
  assert.equal(notes.value.media.dueEdited, false);
  const same = await updateMedia(pool, id, { gatherDate: "2026-12-01" });
  assert.ok(same.ok);
  assert.equal(same.value.media.dueEdited, false, "re-saving the same date isn't an edit");
  const moved = await updateMedia(pool, id, { gatherDate: "2026-12-03" });
  assert.ok(moved.ok);
  assert.equal(moved.value.media.dueEdited, true);
});

test("editing a rule-made post's publishDate sets due_edited", async () => {
  const { post } = await eventWithPost("Rule post");
  await pool.query("UPDATE content_items SET rule_days_before = 14 WHERE id = $1", [post.id]);
  const title = await updateContent(pool, post.id, { title: "Renamed" });
  assert.ok(title.ok);
  assert.equal((await pool.query("SELECT due_edited FROM content_items WHERE id = $1", [post.id])).rows[0].due_edited, false);
  const moved = await updateContent(pool, post.id, { publishDate: "2026-12-06" });
  assert.ok(moved.ok);
  assert.equal((await pool.query("SELECT due_edited FROM content_items WHERE id = $1", [post.id])).rows[0].due_edited, true);
});

test("deleting the event deletes its event-level graphics", async () => {
  const ev = await createEvent(pool, { name: "Doomed" });
  const g = await createEventMedia(pool, ev.id, { description: "Cover" });
  assert.ok(g.ok);
  assert.ok((await deleteEvent(pool, ev.id)).ok);
  const left = await pool.query("SELECT 1 FROM media_assets WHERE id = $1", [g.value.media.id]);
  assert.equal(left.rowCount, 0);
});

test("getEvent returns event-level graphics", async () => {
  const { ev } = await eventWithPost("Detail");
  await createEventMedia(pool, ev.id, { description: "Lower third", graphicType: "lower-third" });
  const r = await getEvent(pool, ev.id);
  assert.ok(r.ok);
  assert.deepEqual(r.value.media.map((m) => [m.description, m.graphicType, m.onEvent]), [["Lower third", "lower-third", true]]);
  assert.equal(r.value.event.source, "manual");
  assert.equal(r.value.event.breezeMissingSince, null);
  assert.equal(r.value.event.anchorDate, null);
});
