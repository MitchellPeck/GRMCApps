import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { createEvent, dashboardGaps, getEvent, listMedia } from "./pipeline/repo";
import { ChecklistItem, ChecklistRule, parseRuleInput, resolveChecklist } from "./pipeline/checklist";
import { applyChecklist, createRule, deleteRule, listRules, updateRule } from "./pipeline/checklist-repo";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

before(async () => {
  await pool.query("DROP TABLE IF EXISTS gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors, metricool_links, media_assets, content_items, recurrences, events, breeze_links, breeze_series, checklist_rules");
  await pool.query(SCHEMA_SQL);
});

after(async () => {
  await pool.query("DELETE FROM media_assets");
  await pool.query("DELETE FROM content_items");
  await pool.query("DELETE FROM events");
  await pool.end();
});

const post = (title: string, daysBefore = 7): ChecklistItem => ({ kind: "post", title, platforms: ["instagram"], daysBefore });
let n = 0;
const rule = (o: Partial<ChecklistRule>): ChecklistRule => ({
  id: "r" + n++, match: "name", calendarId: null, namePattern: "x", effect: "add", repeatMode: null,
  items: [], position: 0, active: true, ...o,
});
const EV = { calendarIds: ["cal1"], name: "Summer VBS (Kids) week" };
const p = (title: string): ChecklistItem => ({ kind: "post", title, platforms: ["instagram"], daysBefore: 1 });
const titles = (items: ChecklistItem[]) => items.map((i) => (i.kind === "post" ? i.title : "g:" + i.graphicType));

test("calendar rule then name rules in position order; add appends, replace replaces", () => {
  const rules = [
    rule({ match: "name", namePattern: "vbs", position: 2, items: [post("B")] }),
    rule({ match: "calendar", calendarId: "cal1", namePattern: "", items: [post("A")] }),
    rule({ match: "name", namePattern: "summer", position: 1, items: [post("C")] }),
  ];
  assert.deepEqual(titles(resolveChecklist(rules, EV).items), ["A", "C", "B"]);
  rules[0].effect = "replace";
  assert.deepEqual(titles(resolveChecklist(rules, EV).items), ["B"]);
});

test("only active rules count", () => {
  const rules = [rule({ namePattern: "vbs", items: [post("A")], active: false }), rule({ namePattern: "vbs", items: [post("B")] })];
  assert.deepEqual(titles(resolveChecklist(rules, EV).items), ["B"]);
});

test("a calendar rule for another calendar doesn't match", () => {
  const rules = [rule({ match: "calendar", calendarId: "other", items: [post("A")] })];
  assert.deepEqual(resolveChecklist(rules, EV).items, []);
});

test("name pattern is literal", () => {
  const rules = [rule({ namePattern: "VBS (Kids)", items: [post("A")] })];
  assert.equal(resolveChecklist(rules, EV).items.length, 1);
  const dot = [rule({ namePattern: "St. Mark's", items: [post("A")] })];
  assert.equal(resolveChecklist(dot, { calendarIds: ["c"], name: "StX Mark's" }).items.length, 0);
  assert.equal(resolveChecklist(dot, { calendarIds: ["c"], name: "st. mark's picnic" }).items.length, 1);
});

test("forPost is rewritten to the resolved list", () => {
  const rules = [
    rule({ match: "calendar", calendarId: "cal1", items: [post("A")] }),
    rule({ namePattern: "vbs", items: [post("B"), { kind: "graphic", graphicType: "ig-feed", daysBefore: 10, forPost: 0 }] }),
  ];
  const { items } = resolveChecklist(rules, EV);
  assert.deepEqual(titles(items), ["A", "B", "g:ig-feed"]);
  const g = items[2];
  assert.ok(g.kind === "graphic");
  assert.equal(g.forPost, 1);
});

test("forPost pointing at a replaced-away post is dropped (graphic goes on the event)", () => {
  const rules = [
    rule({ match: "calendar", calendarId: "cal1", position: 0, items: [post("A"), { kind: "graphic", graphicType: "ig-feed", daysBefore: 10, forPost: 0 }] }),
    rule({ namePattern: "vbs", effect: "replace", items: [{ kind: "graphic", graphicType: "ig-story", daysBefore: 5 }] }),
  ];
  assert.deepEqual(resolveChecklist(rules, EV).items, [{ kind: "graphic", graphicType: "ig-story", daysBefore: 5 }]);
  // and a surviving graphic whose own post was replaced away
  const r2 = [
    rule({ match: "calendar", calendarId: "cal1", items: [post("A"), { kind: "graphic", graphicType: "ig-feed", daysBefore: 10, forPost: 0 }] }),
  ];
  r2[0].items = [r2[0].items[1]];
  assert.equal((resolveChecklist(r2, EV).items[0] as { forPost?: number }).forPost, undefined);
});

test("repeatMode: the last matching rule that sets one wins", () => {
  const rules = [
    rule({ match: "calendar", calendarId: "cal1", repeatMode: "series" }),
    rule({ namePattern: "vbs", repeatMode: "each" }),
    rule({ namePattern: "summer", position: 5 }),
  ];
  assert.equal(resolveChecklist(rules, EV).repeatMode, "each");
  assert.equal(resolveChecklist([rules[0]], EV).repeatMode, "series");
  assert.equal(resolveChecklist([], EV).repeatMode, null);
});

test("parseRuleInput validates", () => {
  const base = { match: "name", namePattern: "vbs", items: [] as unknown[] };
  const bad = (o: Record<string, unknown>) => assert.equal(parseRuleInput({ ...base, ...o }, "create").ok, false, JSON.stringify(o));
  assert.ok(parseRuleInput(base, "create").ok);
  bad({ items: [{ kind: "post", title: "A", platforms: ["myspace"], daysBefore: 3 }] });
  bad({ items: [{ kind: "graphic", graphicType: "poster", daysBefore: 3 }] });
  bad({ items: [{ kind: "post", title: "A", platforms: ["x"], daysBefore: -1 }] });
  bad({ items: [{ kind: "post", title: "A", platforms: ["x"], daysBefore: 1.5 }] });
  bad({ namePattern: "  " });
  bad({ match: "calendar" });
  bad({ items: [{ kind: "graphic", graphicType: "ig-feed", daysBefore: 3, forPost: 0 }] });
  bad({ items: [post("A"), { kind: "graphic", graphicType: "ig-feed", daysBefore: 3, forPost: 1 }] });
  assert.ok(parseRuleInput({ match: "calendar", calendarId: "c", items: [post("A"), { kind: "graphic", graphicType: "ig-feed", daysBefore: 3, forPost: 0 }] }, "create").ok);
  assert.ok(parseRuleInput({ active: false }, "patch").ok);
});

test("rules CRUD", async () => {
  const c = await createRule(pool, { match: "name", namePattern: "Easter", items: [post("Save the date")] });
  assert.ok(c.ok);
  const u = await updateRule(pool, c.value.id, { active: false, repeatMode: "each" });
  assert.ok(u.ok);
  assert.equal(u.value.active, false);
  assert.equal(u.value.namePattern, "Easter");
  assert.equal((await listRules(pool)).length, 1);
  assert.equal((await updateRule(pool, c.value.id, { match: "calendar" })).ok, false);
  assert.ok((await deleteRule(pool, c.value.id)).ok);
  assert.equal((await deleteRule(pool, c.value.id)).ok, false);
});

async function applied() {
  const ev = await createEvent(pool, { name: "Christmas Eve", startDate: "2026-12-20", ownerEmail: "owner@x" });
  const items: ChecklistItem[] = [
    { kind: "post", title: "{event} — {date}", platforms: ["instagram", "facebook"], daysBefore: 14 },
    { kind: "graphic", graphicType: "ig-feed", daysBefore: 17, forPost: 0 },
    { kind: "graphic", graphicType: "fb-event-cover", daysBefore: 20 },
  ];
  const counts = await applyChecklist(pool, ev.id, items, { name: ev.name, date: "2026-12-20", ownerEmail: "owner@x" }, "t@x");
  return { ev, counts };
}

test("applyChecklist creates planned posts and graphics with due dates", async () => {
  const { ev, counts } = await applied();
  assert.deepEqual(counts, { posts: 1, graphics: 2 });
  const row = (await pool.query("SELECT * FROM content_items WHERE event_id = $1", [ev.id])).rows[0];
  assert.equal(row.publish_date, "2026-12-06");
  assert.equal(row.status, "planned");
  assert.equal(row.owner_email, "owner@x");
  assert.equal(row.rule_days_before, 14);
  assert.equal(row.title, "Christmas Eve — Dec 20, 2026");
  const media = await listMedia(pool, { eventId: ev.id });
  const onPost = media.find((m) => m.graphicType === "ig-feed")!;
  assert.equal(onPost.contentItemId, row.id);
  assert.equal(onPost.gatherDate, "2026-12-03");
  assert.equal(onPost.description, "Instagram feed");
  const onEv = media.find((m) => m.graphicType === "fb-event-cover")!;
  assert.equal(onEv.contentItemId, null);
  assert.equal(onEv.onEvent, true);
  const raw = (await pool.query("SELECT rule_days_before FROM media_assets WHERE event_id = $1", [ev.id])).rows;
  assert.equal(raw[0].rule_days_before, 20);
  assert.ok((await getEvent(pool, ev.id)).ok);
});

test("applyChecklist rolls back if anything fails", async () => {
  const ev = await createEvent(pool, { name: "Rollback", startDate: "2026-12-20" });
  // The second post has no title, so it throws after the first was created.
  await assert.rejects(applyChecklist(pool, ev.id, [post("A"), { kind: "post", title: undefined as unknown as string, platforms: ["x"], daysBefore: 1 }], { name: "R", date: "2026-12-20", ownerEmail: "" }, "t@x"));
  assert.equal((await pool.query("SELECT 1 FROM content_items WHERE event_id = $1", [ev.id])).rowCount, 0);
});

test("applyChecklist given a PoolClient runs inside the caller's transaction", async () => {
  const ev = await createEvent(pool, { name: "Caller tx", startDate: "2026-12-20" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const counts = await applyChecklist(client, ev.id, [post("A"), { kind: "graphic", graphicType: "ig-feed", daysBefore: 3, forPost: 0 }],
      { name: ev.name, date: "2026-12-20", ownerEmail: "" }, "t@x");
    assert.deepEqual(counts, { posts: 1, graphics: 1 });
    await client.query("ROLLBACK");
  } finally { client.release(); }
  assert.equal((await pool.query("SELECT 1 FROM content_items WHERE event_id = $1", [ev.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM media_assets WHERE event_id = $1", [ev.id])).rowCount, 0);
});

test("a rule-made post with its graphic attached is not a no-media gap", async () => {
  const { ev } = await applied();
  const bare = await createEvent(pool, { name: "Bare", startDate: "2026-12-20" });
  await applyChecklist(pool, bare.id, [post("Lonely")], { name: "Bare", date: "2026-12-20", ownerEmail: "" }, "t@x");
  const withG = (await pool.query("SELECT id FROM content_items WHERE event_id = $1", [ev.id])).rows[0];
  const without = (await pool.query("SELECT id FROM content_items WHERE event_id = $1", [bare.id])).rows[0];
  const { gaps } = await dashboardGaps(pool, "2026-12-01");
  const noMedia = gaps.find((g) => g.key === "no-media");
  assert.ok(noMedia, "control: the post with no graphic should produce a no-media gap");
  assert.ok(noMedia.ids.includes(without.id));
  assert.ok(!noMedia.ids.includes(withG.id));
});

test("calendar rules for every linked calendar apply, in the given order", () => {
  const rules = [rule({ match: "calendar", calendarId: "b", items: [p("B")] }),
                 rule({ match: "calendar", calendarId: "a", items: [p("A")] })];
  assert.deepEqual(titles(resolveChecklist(rules, { calendarIds: ["a", "b"], name: "x" }).items), ["A", "B"]);
  assert.deepEqual(titles(resolveChecklist(rules, { calendarIds: ["b"], name: "x" }).items), ["B"]);
});
