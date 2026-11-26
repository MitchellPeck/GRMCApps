import { strict as assert } from "node:assert";
import { test, before, beforeEach, after } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { createEvent, updateContent } from "./pipeline/repo";
import { createRule } from "./pipeline/checklist-repo";
import { applyRulesToEvent, listSeries, setSeriesMode, syncBreeze } from "./pipeline/breeze-sync";
import { getSetting, getSettingsView, setSetting } from "./settings";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const TODAY = "2026-12-01";
const OWNER = "owner@grmc.test";

before(async () => {
  await pool.query("DROP TABLE IF EXISTS gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors, metricool_links, media_assets, content_items, recurrences, events, breeze_links, breeze_series, checklist_rules");
  await pool.query(SCHEMA_SQL);
});

// What the fake Breeze returns per calendar: rows, or an HTTP status to fail with.
let feed: Record<string, unknown[] | number | object> = {};
let calls: string[] = [];
const fakeFetch = (async (url: unknown) => {
  const cal = new URL(String(url)).searchParams.get("category_id") ?? "";
  calls.push(cal);
  const v = feed[cal] ?? [];
  if (typeof v === "number") return new Response("down", { status: v });
  return new Response(JSON.stringify(v), { status: 200 });
}) as unknown as typeof fetch;

const inst = (id: string, eventId: string, name: string, date: string, cal = "10") =>
  ({ id, event_id: eventId, name, category_id: cal, start_datetime: `${date} 19:00:00` });
const sync = (today = TODAY) => syncBreeze(pool, today, fakeFetch);

beforeEach(async () => {
  await pool.query("TRUNCATE media_assets, content_items, events, breeze_links, breeze_series, checklist_rules CASCADE");
  await pool.query("DELETE FROM settings WHERE key LIKE 'breeze_%'");
  await setSetting(pool, "breeze_subdomain", "grmc");
  await setSetting(pool, "breeze_api_key", "KEY");
  await setSetting(pool, "breeze_calendars", JSON.stringify(["10", "20"]));
  await setSetting(pool, "breeze_default_owner", OWNER);
  feed = {};
  calls = [];
});

after(async () => {
  await pool.query("DELETE FROM settings WHERE key LIKE 'breeze_%'");
  await pool.end();
});

const post = (title: string, daysBefore: number) => ({ kind: "post", title, platforms: ["instagram"], daysBefore });
async function addRule(input: Record<string, unknown>, repeatMode?: string) {
  const r = await createRule(pool, repeatMode ? { ...input, repeatMode } : input);
  assert.ok(r.ok, r.ok ? "" : r.error);
}
const calRule = (items: unknown[], cal = "10") => addRule({ match: "calendar", calendarId: cal, items });
const nameRule = (namePattern: string, items: unknown[], repeatMode?: string) =>
  addRule({ match: "name", namePattern, items }, repeatMode);

const events = async (where = "TRUE", args: unknown[] = []) =>
  (await pool.query(`SELECT * FROM events WHERE ${where} ORDER BY start_date, created_at`, args)).rows;
const postsOf = async (eventId: string) =>
  (await pool.query("SELECT * FROM content_items WHERE event_id = $1 ORDER BY title", [eventId])).rows;
const series = async (id: string) =>
  (await pool.query("SELECT * FROM breeze_series WHERE breeze_event_id = $1", [id])).rows[0];
const count = async (table: string) => Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

test("new one-off creates one event with its checklist", async () => {
  await calRule([post("{event} — save the date", 14), { kind: "graphic", graphicType: "ig-feed", daysBefore: 17, forPost: 0 }]);
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24")];
  const r = await sync();
  assert.equal(r.created, 1);
  assert.equal(r.calendars, 2);
  assert.deepEqual(r.failedCalendars, []);
  const [ev] = await events();
  assert.equal(ev.name, "Christmas Eve");
  assert.equal(ev.kind, "event");
  assert.equal(ev.source, "breeze");
  assert.equal(ev.breeze_event_id, "s1");
  assert.equal(ev.breeze_instance_id, "i1");
  assert.equal(ev.breeze_calendar_id, "10");
  assert.equal(ev.start_date, "2026-12-24");
  assert.equal(ev.anchor_date, "2026-12-24");
  assert.equal(ev.anchor_instance_id, "i1");
  assert.equal(ev.owner_email, OWNER);
  assert.ok(ev.synced_at);
  const posts = await postsOf(ev.id);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].publish_date, "2026-12-10");
  assert.equal(posts[0].owner_email, OWNER);
  assert.equal(await count("media_assets"), 1);
  const s = await series("s1");
  assert.equal(s.mode, "single");
  assert.equal(s.mode_source, "auto");
  assert.ok(await getSetting(pool, "breeze_last_sync"));
});

test("a second sync creates nothing new", async () => {
  await calRule([post("A", 7)]);
  feed["10"] = [inst("i1", "s1", "Concert", "2026-12-24"), ...["12-06", "12-13"].map((d, i) => inst("w" + i, "s2", "Choir", "2026-" + d))];
  const first = await sync();
  assert.equal(first.created, 2);
  const before = [await count("events"), await count("content_items")];
  const r = await sync();
  assert.equal(r.created, 0);
  assert.equal(r.updated, 0);
  assert.equal(r.flaggedMissing, 0);
  assert.deepEqual([await count("events"), await count("content_items")], before);
});

const weekly = (eventId: string, name: string, dates = ["12-06", "12-13", "12-20", "12-27"], cal = "10") =>
  dates.map((d, i) => inst(`${eventId}-${i}`, eventId, name, "2026-" + d, cal));

test("a weekly series becomes one event with one checklist", async () => {
  await calRule([post("Invite", 3)]);
  feed["10"] = weekly("s2", "Youth Night");
  const r = await sync();
  assert.equal(r.created, 1);
  const evs = await events();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].breeze_event_id, "s2");
  assert.equal(evs[0].breeze_instance_id, null);
  assert.equal(evs[0].start_date, "2026-12-06");
  assert.equal(evs[0].anchor_instance_id, "s2-0");
  assert.equal(evs[0].anchor_date, "2026-12-06");
  assert.equal((await postsOf(evs[0].id)).length, 1);
  assert.equal((await series("s2")).mode, "series");
});

test("each mode makes one event per instance, each with a checklist", async () => {
  await nameRule("bible study", [post("Come", 2)], "each");
  feed["10"] = weekly("s3", "Bible Study", ["12-03", "12-10", "12-17"]);
  const r = await sync();
  assert.equal(r.created, 3);
  const evs = await events();
  assert.deepEqual(evs.map((e) => [e.breeze_instance_id, e.start_date]), [
    ["s3-0", "2026-12-03"], ["s3-1", "2026-12-10"], ["s3-2", "2026-12-17"]]);
  for (const e of evs) assert.equal((await postsOf(e.id)).length, 1);
  const s = await series("s3");
  assert.equal(s.mode, "each");
  assert.equal(s.mode_source, "rule");
});

test("ignore makes nothing", async () => {
  await nameRule("staff meeting", [post("x", 1)], "ignore");
  feed["10"] = weekly("s4", "Staff Meeting");
  const r = await sync();
  assert.equal(r.created, 0);
  assert.equal(await count("events"), 0);
  assert.equal((await series("s4")).mode, "ignore");
  assert.equal((await sync()).flaggedMissing, 0);
});

test("rule repeat_mode sets a new series' mode", async () => {
  // One instance alone would be `single`; the rule says series.
  await nameRule("prayer", [], "series");
  feed["10"] = [inst("p1", "s5", "Prayer Vigil", "2026-12-12")];
  await sync();
  const s = await series("s5");
  assert.equal(s.mode, "series");
  assert.equal(s.mode_source, "rule");
  const [ev] = await events();
  assert.equal(ev.breeze_instance_id, null);
  assert.equal(ev.breeze_event_id, "s5");
});

test("setSeriesMode to each, then sync creates the per-instance events and leaves the series event alone", async () => {
  await calRule([post("Invite", 3)]);
  feed["10"] = weekly("s6", "Youth Night");
  await sync();
  const [seriesEv] = await events();
  assert.ok((await setSeriesMode(pool, "s6", "each")).ok);
  assert.equal((await series("s6")).mode_source, "user");
  assert.equal((await setSeriesMode(pool, "nope", "each")).ok, false);
  assert.equal((await setSeriesMode(pool, "s6", "single" as never)).ok, false);
  feed["10"] = weekly("s6", "Youth Night (new)");
  const r = await sync();
  assert.equal(r.created, 4);
  assert.equal(r.flaggedMissing, 0);
  const still = (await events("id = $1", [seriesEv.id]))[0];
  assert.equal(still.name, "Youth Night");
  assert.equal(still.breeze_missing_since, null);
  assert.equal((await postsOf(seriesEv.id)).length, 1);
  const each = await events("breeze_instance_id IS NOT NULL");
  assert.equal(each.length, 4);
  for (const e of each) assert.equal((await postsOf(e.id)).length, 1);
  const listed = (await listSeries(pool)).find((s) => s.breezeEventId === "s6")!;
  assert.deepEqual([listed.mode, listed.modeSource, listed.eventCount, listed.calendarId], ["each", "user", 5, "10"]);
});

test("series start_date rolling forward shifts nothing", async () => {
  await calRule([post("Invite", 7)]);
  feed["10"] = weekly("s7", "Youth Night", ["12-06", "12-13", "12-20"]);
  await sync();
  const [ev] = await events();
  assert.equal((await postsOf(ev.id))[0].publish_date, "2026-11-29");
  // A week later the first night is past and Breeze returns the next three.
  feed["10"] = weekly("s7", "Youth Night", ["12-13", "12-20", "12-27"]).map((x, i) => ({ ...x, id: `s7-${i + 1}` }));
  const r = await sync("2026-12-07");
  assert.equal(r.shifted, 0);
  assert.equal(r.flaggedMissing, 0);
  const [after] = await events();
  assert.equal(after.start_date, "2026-12-13");
  assert.equal(after.anchor_date, "2026-12-06");
  assert.equal((await postsOf(ev.id))[0].publish_date, "2026-11-29");
});

test("move shifts open items once", async () => {
  await calRule([post("A open", 14), post("B edited", 10), post("C published", 7),
    { kind: "graphic", graphicType: "ig-feed", daysBefore: 17 }]);
  feed["10"] = [inst("m1", "s8", "Pageant", "2026-12-20")];
  await sync();
  const [ev] = await events();
  const [a, b, c] = await postsOf(ev.id);
  assert.ok((await updateContent(pool, b.id, { publishDate: "2026-12-09" })).ok);
  await pool.query("UPDATE content_items SET status = 'published' WHERE id = $1", [c.id]);
  feed["10"] = [inst("m1", "s8", "Pageant", "2026-12-27")];
  const r = await sync();
  assert.equal(r.shifted, 1);
  const dates = async () => (await postsOf(ev.id)).map((p) => [p.title, p.publish_date, p.due_edited]);
  const expected = [["A open", "2026-12-13", false], ["B edited", "2026-12-09", true], ["C published", "2026-12-13", false]];
  assert.deepEqual(await dates(), expected);
  const g = (await pool.query("SELECT gather_date, due_edited FROM media_assets WHERE event_id = $1", [ev.id])).rows[0];
  assert.deepEqual([g.gather_date, g.due_edited], ["2026-12-10", false]);
  const [moved] = await events();
  assert.deepEqual([moved.start_date, moved.anchor_date], ["2026-12-27", "2026-12-27"]);
  assert.equal(a.publish_date, "2026-12-06");
  const again = await sync();
  assert.equal(again.shifted, 0);
  assert.deepEqual(await dates(), expected);
});

test("rename in Breeze renames the event", async () => {
  feed["10"] = [inst("r1", "s9", "Christmas Concert", "2026-12-19")];
  await sync();
  feed["10"] = [inst("r1", "s9", "Christmas Cantata", "2026-12-19")];
  const r = await sync();
  assert.equal(r.updated, 1);
  assert.equal((await events())[0].name, "Christmas Cantata");
  assert.equal((await series("s9")).name, "Christmas Cantata");
});

test("single becomes series when a second instance appears", async () => {
  await calRule([post("Invite", 5)]);
  feed["10"] = [inst("o1", "s10", "Men's Breakfast", "2026-12-12")];
  await sync();
  const [orig] = await events();
  feed["10"] = [inst("o1", "s10", "Men's Breakfast", "2026-12-12"), inst("o2", "s10", "Men's Breakfast", "2027-01-09")];
  const r = await sync();
  assert.equal(r.becameSeries, 1);
  assert.equal(r.created, 0);
  const evs = await events();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].id, orig.id);
  assert.equal(evs[0].breeze_instance_id, null);
  assert.equal(evs[0].anchor_instance_id, "o1");
  assert.equal(evs[0].anchor_date, "2026-12-12");
  assert.equal((await postsOf(orig.id)).length, 1);
  const s = await series("s10");
  assert.equal(s.mode, "series");
  assert.equal(s.mode_source, "auto");
  assert.ok(s.became_series_at);
  const again = await sync();
  assert.deepEqual([again.created, again.becameSeries], [0, 0]);
  assert.equal(await count("events"), 1);
});

test("a removed instance flags its event, a returning one clears it", async () => {
  const both = [inst("a1", "sa", "Cookie Swap", "2026-12-10"), inst("b1", "sb", "Caroling", "2026-12-12")];
  feed["10"] = both;
  await sync();
  feed["10"] = [both[0]];
  const r = await sync();
  assert.equal(r.flaggedMissing, 1);
  const flagged = async () => (await events("breeze_missing_since IS NOT NULL")).map((e) => e.breeze_instance_id);
  assert.deepEqual(await flagged(), ["b1"]);
  const firstFlag = (await events("breeze_instance_id = 'b1'"))[0].breeze_missing_since;
  assert.equal((await sync()).flaggedMissing, 0);
  assert.deepEqual((await events("breeze_instance_id = 'b1'"))[0].breeze_missing_since, firstFlag);
  feed["10"] = both;
  const back = await sync();
  assert.equal(back.cleared, 1);
  assert.deepEqual(await flagged(), []);
});

test("a kept event stays kept while Breeze still lacks it; an un-kept one is flagged", async () => {
  const both = [inst("k1", "sk", "Pie Social", "2026-12-10"), inst("k2", "sl", "Hymn Sing", "2026-12-12")];
  feed["10"] = both;
  await sync();
  feed["10"] = [];
  assert.equal((await sync()).flaggedMissing, 2);
  // The user keeps Pie Social (what the page's Keep sends).
  await pool.query("UPDATE events SET breeze_missing_since = NULL, breeze_kept = true WHERE breeze_instance_id = 'k1'");
  const r = await sync();
  assert.equal(r.flaggedMissing, 0);
  assert.equal((await events("breeze_instance_id = 'k1'"))[0].breeze_missing_since, null);
  assert.ok((await events("breeze_instance_id = 'k2'"))[0].breeze_missing_since, "the un-kept one stays flagged");
  // If it comes back, it just updates as normal.
  feed["10"] = [inst("k1", "sk", "Pie Social (moved)", "2026-12-10")];
  await sync();
  const k1 = (await events("breeze_instance_id = 'k1'"))[0];
  assert.equal(k1.name, "Pie Social (moved)");
  assert.equal(k1.breeze_kept, true);
});

test("one missing week doesn't flag a series event", async () => {
  feed["10"] = weekly("s11", "Youth Night");
  await sync();
  feed["10"] = weekly("s11", "Youth Night").filter((x) => x.id !== "s11-1");
  assert.equal((await sync()).flaggedMissing, 0);
  // With none left in the window it is flagged.
  feed["10"] = [];
  assert.equal((await sync()).flaggedMissing, 1);
  assert.equal((await events("breeze_missing_since IS NOT NULL")).length, 1);
});

test("fetch failure flags nothing", async () => {
  feed["10"] = [inst("f1", "sf", "Advent Supper", "2026-12-09")];
  feed["20"] = [inst("g1", "sg", "Toy Drive", "2026-12-14", "20")];
  await sync();
  feed["10"] = 500;
  feed["20"] = [inst("g1", "sg", "Toy Drive", "2026-12-14", "20"), inst("g2", "sh", "Food Drive", "2026-12-15", "20")];
  const r = await sync();
  assert.deepEqual(r.failedCalendars, ["10"]);
  assert.equal(r.created, 1, "the other calendar carries on");
  assert.equal(r.flaggedMissing, 0);
  assert.equal((await events("breeze_missing_since IS NOT NULL")).length, 0);
  // A 200 with an error object instead of a list is a failure too.
  feed["10"] = { error: "bad key" };
  const r2 = await sync();
  assert.deepEqual(r2.failedCalendars, ["10"]);
  assert.equal((await events("breeze_missing_since IS NOT NULL")).length, 0);
});

test("a calendar with a dateless event fails and flags nothing", async () => {
  feed["10"] = [inst("d1", "sd", "Advent Supper", "2026-12-09"), inst("d2", "se", "Carols", "2026-12-12")];
  await sync();
  // Breeze now sends one of them back with no date: it must not read as Carols being removed.
  feed["10"] = [inst("d1", "sd", "Advent Supper", "2026-12-09"), { id: "d2", event_id: "se", name: "Carols", category_id: "10" }];
  const r = await sync();
  assert.deepEqual(r.failedCalendars, ["10"]);
  assert.equal(r.flaggedMissing, 0);
  assert.equal((await events("breeze_missing_since IS NOT NULL")).length, 0);
});

test("the settings page sees the last sync time and which calendars failed", async () => {
  feed["10"] = 500;
  await sync();
  let view = await getSettingsView(pool);
  assert.ok(view.breezeLastSync);
  assert.deepEqual(view.breezeLastSyncFailed, ["10"]);
  assert.deepEqual(view.breezeCalendarNames, {});
  feed["10"] = [];
  await sync();
  view = await getSettingsView(pool);
  assert.deepEqual(view.breezeLastSyncFailed, []);
});

test("unticked calendar flags nothing", async () => {
  feed["10"] = [inst("u1", "su", "Advent Supper", "2026-12-09")];
  feed["20"] = [inst("v1", "sv", "Toy Drive", "2026-12-14", "20")];
  await sync();
  await setSetting(pool, "breeze_calendars", JSON.stringify(["10"]));
  feed["20"] = [];
  calls = [];
  const r = await sync();
  assert.deepEqual(calls, ["10"]);
  assert.equal(r.calendars, 1);
  assert.equal(r.flaggedMissing, 0);
  assert.equal((await events("breeze_missing_since IS NOT NULL")).length, 0);
});

test("not connected → skipped, no queries to Breeze", async () => {
  await pool.query("DELETE FROM settings WHERE key = 'breeze_api_key'");
  feed["10"] = [inst("n1", "sn", "x", "2026-12-09")];
  const r = await sync();
  assert.equal(r.skipped, "not-connected");
  assert.deepEqual(calls, []);
  assert.equal(await count("events"), 0);
  await setSetting(pool, "breeze_api_key", "KEY");
  await setSetting(pool, "breeze_calendars", "[]");
  assert.equal((await sync()).skipped, "no-calendars");
  assert.deepEqual(calls, []);
});

test("applyRulesToEvent works once on an empty event and refuses a second time", async () => {
  await nameRule("egg hunt", [post("{event} invite", 10), { kind: "graphic", graphicType: "ig-feed", daysBefore: 12 }]);
  const ev = await createEvent(pool, { name: "Easter Egg Hunt", startDate: "2027-03-27", ownerEmail: "me@x" });
  const r = await applyRulesToEvent(pool, ev.id);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { posts: 1, graphics: 1 });
  const [p] = await postsOf(ev.id);
  assert.deepEqual([p.publish_date, p.owner_email], ["2027-03-17", "me@x"]);
  assert.equal((await applyRulesToEvent(pool, ev.id)).ok, false);
  assert.equal((await postsOf(ev.id)).length, 1);
  const none = await createEvent(pool, { name: "Board meeting", startDate: "2027-03-27" });
  assert.equal((await applyRulesToEvent(pool, none.id)).ok, false);
  assert.equal((await applyRulesToEvent(pool, "missing-id")).ok, false);
});

test("a synced event gets one link per Breeze copy", async () => {
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24")];
  await sync();
  const [ev] = await events();
  const links = (await pool.query("SELECT * FROM breeze_links WHERE event_id = $1", [ev.id])).rows;
  assert.equal(links.length, 1);
  assert.equal(links[0].breeze_instance_id, "i1");
  assert.equal(links[0].calendar_id, "10");
});

test("schema backfills a link for a Breeze event made before links existed", async () => {
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24")];
  await sync();
  await pool.query("TRUNCATE breeze_links");
  await pool.query(SCHEMA_SQL);
  assert.equal(await count("breeze_links"), 1);
});

test("an event moved to another calendar in Breeze has its link follow", async () => {
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24")];
  await sync();
  feed = { "20": [inst("i1", "s1", "Christmas Eve", "2026-12-24", "20")] };
  await sync();
  const [ev] = await events();
  const links = (await pool.query("SELECT * FROM breeze_links WHERE event_id = $1", [ev.id])).rows;
  assert.equal(links.length, 1);
  assert.equal(links[0].calendar_id, "20");
});

test("single becoming a series leaves exactly one series link", async () => {
  feed["10"] = [inst("o1", "s10", "Men's Breakfast", "2026-12-12")];
  await sync();
  feed["10"] = [inst("o1", "s10", "Men's Breakfast", "2026-12-12"), inst("o2", "s10", "Men's Breakfast", "2027-01-09")];
  await sync();
  await pool.query(SCHEMA_SQL); // the boot backfill must not add a duplicate
  const [ev] = await events();
  const links = (await pool.query("SELECT * FROM breeze_links WHERE event_id = $1", [ev.id])).rows;
  assert.equal(links.length, 1);
  assert.equal(links[0].breeze_instance_id, null);
  assert.equal(links[0].breeze_event_id, "s10");
});

// ── The same Breeze event on several calendars ──────────────────────────────

const linksOf = async (eventId: string) =>
  (await pool.query("SELECT * FROM breeze_links WHERE event_id = $1 ORDER BY calendar_id, breeze_instance_id", [eventId])).rows;

test("the same event on two calendars makes one event with both calendars' rules", async () => {
  await calRule([post("A {event}", 7)], "10");
  await calRule([post("B {event}", 3)], "20");
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24", "10")];
  feed["20"] = [inst("i2", "s2", "christmas  eve", "2026-12-24", "20")];
  const r = await sync();
  assert.equal(r.created, 1);
  const [ev] = await events();
  assert.deepEqual((await postsOf(ev.id)).map((p) => p.title), ["A Christmas Eve", "B Christmas Eve"]);
  assert.equal(await count("breeze_links"), 2);
  assert.deepEqual((await linksOf(ev.id)).map((l) => [l.breeze_event_id, l.breeze_instance_id, l.calendar_id]),
    [["s1", "i1", "10"], ["s2", "i2", "20"]]);
  assert.deepEqual([ev.breeze_event_id, ev.breeze_instance_id, ev.breeze_calendar_id], ["s1", "i1", "10"]);
});

test("a second sync of merged copies creates nothing", async () => {
  await calRule([post("A {event}", 7)], "10");
  await calRule([post("B {event}", 3)], "20");
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24", "10")];
  feed["20"] = [inst("i2", "s2", "christmas  eve", "2026-12-24", "20")];
  await sync();
  const r = await sync();
  assert.deepEqual([r.created, r.updated, r.flaggedMissing], [0, 0, 0]);
  assert.equal(await count("events"), 1);
  assert.equal(await count("content_items"), 2);
  assert.equal(await count("breeze_links"), 2);
});

test("same name different dates on two calendars makes two events", async () => {
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24", "10")];
  feed["20"] = [inst("i2", "s2", "Christmas Eve", "2026-12-31", "20")];
  const r = await sync();
  assert.equal(r.created, 2);
  assert.deepEqual((await events()).map((e) => [e.breeze_instance_id, e.start_date]),
    [["i1", "2026-12-24"], ["i2", "2026-12-31"]]);
});

test("a copy appearing later links to the existing event without new posts", async () => {
  await calRule([post("A {event}", 7)], "10");
  await calRule([post("B {event}", 3)], "20");
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24", "10")];
  await sync();
  const [ev] = await events();
  feed["20"] = [inst("i2", "s2", "Christmas Eve", "2026-12-24", "20")];
  const r = await sync();
  assert.equal(r.created, 0);
  assert.equal(await count("events"), 1);
  assert.equal((await linksOf(ev.id)).length, 2);
  assert.deepEqual((await postsOf(ev.id)).map((p) => p.title), ["A Christmas Eve"]);
  assert.equal((await series("s2")).merged_into, "s1");
});

test("a weekly series on two calendars is one series event", async () => {
  await calRule([post("Invite", 3)], "10");
  await calRule([post("Welcome", 1)], "20");
  const sundays = ["12-06", "12-13", "12-20"];
  feed["10"] = weekly("s1", "Worship", sundays, "10");
  feed["20"] = weekly("s2", "Worship", sundays, "20");
  const r = await sync();
  assert.equal(r.created, 1);
  const evs = await events();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].breeze_instance_id, null);
  assert.deepEqual((await postsOf(evs[0].id)).map((p) => p.title), ["Invite", "Welcome"]);
  assert.deepEqual((await linksOf(evs[0].id)).map((l) => [l.breeze_event_id, l.breeze_instance_id]),
    [["s1", null], ["s2", null]]);
  const listed = await listSeries(pool);
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0].breezeEventId, listed[0].mode, listed[0].eventCount], ["s1", "series", 1]);
  assert.equal((await series("s2")).merged_into, "s1");
  assert.equal((await sync()).created, 0);
});

test("setting a merged series' mode applies to its copies", async () => {
  const sundays = ["12-06", "12-13", "12-20"];
  feed["10"] = weekly("s1", "Worship", sundays, "10");
  feed["20"] = weekly("s2", "Worship", sundays, "20");
  await sync();
  assert.ok((await setSeriesMode(pool, "s1", "each")).ok);
  assert.deepEqual([(await series("s1")).mode, (await series("s2")).mode], ["each", "each"]);
  const r = await sync();
  assert.equal(r.created, 3);
  const each = await events("breeze_instance_id IS NOT NULL");
  assert.deepEqual(each.map((e) => e.start_date), ["2026-12-06", "2026-12-13", "2026-12-20"]);
  for (const [i, e] of each.entries()) {
    assert.deepEqual((await linksOf(e.id)).map((l) => l.breeze_instance_id), [`s1-${i}`, `s2-${i}`]);
  }
  assert.deepEqual([(await series("s1")).mode, (await series("s2")).mode], ["each", "each"]);
  assert.equal((await sync()).created, 0);
});

test("a failed calendar still lets the other calendar's events sync", async () => {
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24", "10")];
  feed["20"] = 500;
  const r = await sync();
  assert.equal(r.created, 1);
  assert.deepEqual(r.failedCalendars, ["20"]);
  const [ev] = await events();
  assert.equal(ev.breeze_instance_id, "i1");
});

test("a save that fails saves nothing and counts every calendar read as failed", async () => {
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24", "10")];
  await sync();
  await pool.query(`CREATE OR REPLACE FUNCTION boom() RETURNS trigger AS $$
    BEGIN IF NEW.name = 'Boom' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query("CREATE TRIGGER boom BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION boom()");
  try {
    feed["10"] = [inst("i3", "s3", "Advent Supper", "2026-12-09", "10")];
    feed["20"] = [inst("i2", "s2", "Boom", "2026-12-14", "20")];
    const r = await sync();
    assert.deepEqual(r.failedCalendars, ["10", "20"]);
    assert.deepEqual([r.created, r.flaggedMissing], [0, 0]);
    assert.deepEqual((await events()).map((e) => e.name), ["Christmas Eve"]);
    assert.equal((await events("breeze_missing_since IS NOT NULL")).length, 0);
    assert.deepEqual(JSON.parse((await getSetting(pool, "breeze_last_sync_failed"))!), ["10", "20"]);
  } finally {
    await pool.query("DROP TRIGGER boom ON events");
  }
});

test("copies already on two events: a new copy joins the earlier one and neither is merged", async () => {
  feed["10"] = [inst("i1", "s1", "Christmas Eve", "2026-12-24", "10")];
  await sync();
  feed = { "10": 500, "20": [inst("i2", "s2", "Christmas Eve", "2026-12-24", "20")] };
  await sync();
  const [e1, e2] = await events();
  assert.ok(e1 && e2, "two events while calendar 10 was down");
  feed = {
    "10": [inst("i1", "s1", "Christmas Eve", "2026-12-24", "10"), inst("i3", "s3", "Christmas Eve", "2026-12-24", "10")],
    "20": [inst("i2", "s2", "Christmas Eve", "2026-12-24", "20")],
  };
  const r = await sync();
  assert.equal(r.created, 0);
  assert.equal(await count("events"), 2);
  assert.deepEqual((await linksOf(e1.id)).map((l) => l.breeze_instance_id), ["i1", "i3"]);
  assert.deepEqual((await linksOf(e2.id)).map((l) => l.breeze_instance_id), ["i2"]);
});
