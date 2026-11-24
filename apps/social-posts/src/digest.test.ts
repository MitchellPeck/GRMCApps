import { strict as assert } from "node:assert";
import { test, before, beforeEach, after } from "node:test";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { getSetting, setSetting } from "./settings";
import { Digest, buildDigests, digestSlot, digestText, digestTick } from "./pipeline/digest";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const TODAY = "2026-12-01";
const BASE = "https://posts.example.org";
const A = "a@grmc.test", B = "b@grmc.test", DEF = "def@grmc.test";
const KEYS = ["resend_api_key", "mail_from", "public_base_url", "default_timezone", "breeze_default_owner", "digest_last_slot", "digest_last_sent_at"];

before(async () => {
  await pool.query("DROP TABLE IF EXISTS gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors, metricool_links, media_assets, content_items, recurrences, events, breeze_series, checklist_rules");
  await pool.query(SCHEMA_SQL);
});
beforeEach(async () => {
  await pool.query("TRUNCATE media_assets, content_items, events, breeze_series CASCADE");
  await pool.query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
});
after(async () => { await pool.query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]); await pool.end(); });

const ev = async (name: string, o: { owner?: string; source?: string; start?: string | null; archived?: boolean; created?: string; missing?: boolean; breezeEvent?: string } = {}) =>
  (await pool.query(
    `INSERT INTO events (name, owner_email, source, start_date, archived, created_at, breeze_missing_since, breeze_event_id)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()),CASE WHEN $7 THEN now() END,$8) RETURNING id`,
    [name, o.owner ?? "", o.source ?? "manual", o.start ?? null, o.archived ?? false, o.created ?? null, o.missing ?? false, o.breezeEvent ?? null])).rows[0].id as string;
const post = async (title: string, o: { event?: string | null; owner?: string; date?: string | null; status?: string } = {}) =>
  (await pool.query(
    "INSERT INTO content_items (title, event_id, owner_email, publish_date, status) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [title, o.event ?? null, o.owner ?? "", o.date ?? null, o.status ?? "planned"])).rows[0].id as string;
const media = (desc: string, o: { post?: string; event?: string; date: string | null; status?: string; kind?: string }) =>
  pool.query(
    "INSERT INTO media_assets (content_item_id, event_id, description, type, gather_date, status, kind) VALUES ($1,$2,$3,'graphic',$4,$5,$6)",
    [o.post ?? null, o.event ?? null, desc, o.date, o.status ?? "needed", o.kind ?? "collect"]);
const find = (ds: Digest[], to: string) => ds.find((d) => d.to === to);

test("digestSlot", () => {
  assert.equal(digestSlot({ date: "2026-11-30", time: "07:59" }, ""), null);
  assert.equal(digestSlot({ date: "2026-11-30", time: "08:00" }, ""), "2026-11-30");
  assert.equal(digestSlot({ date: "2026-11-30", time: "08:00" }, "2026-11-30"), null);
  assert.equal(digestSlot({ date: "2026-12-01", time: "09:00" }, ""), null);
  assert.equal(digestSlot({ date: "2026-12-03", time: "15:00" }, "2026-11-30"), "2026-12-03");
  assert.equal(digestSlot({ date: "2026-12-04", time: "09:00" }, "2026-11-30"), null);
});

test("overdue, due soon, owners and links", async () => {
  const e = await ev("Retreat", { owner: A });
  await post("Late post", { event: e, date: "2026-11-28" });
  await post("Soon post", { event: e, date: "2026-12-04", owner: B });
  await post("Far post", { event: e, date: "2026-12-20" });
  await post("Done post", { event: e, date: "2026-11-20", status: "published" });
  await post("Cancelled", { event: e, date: "2026-11-20", status: "cancelled" });
  await post("Loose post", { date: "2026-11-25" });
  const p = await post("Owned post", { event: e, owner: B, date: "2026-12-30" });
  await media("Post graphic", { post: p, date: "2026-11-29" });
  await media("Event graphic", { event: e, date: "2026-11-27" });
  await media("Finished", { event: e, date: "2026-11-27", status: "edited" });
  await media("Attachment", { event: e, date: "2026-11-27", kind: "attachment" });
  const arch = await ev("Old", { owner: A, archived: true });
  await post("Archived post", { event: arch, date: "2026-11-01" });

  const ds = await buildDigests(pool, TODAY, null, BASE + "/", DEF);
  const a = find(ds, A)!, b = find(ds, B)!, d = find(ds, DEF)!;
  assert.equal(a.overdue.length, 2); // Late post (event owner) + event graphic
  assert.ok(a.overdue.some((l) => l.text.includes("Late post") && l.url === `${BASE}/#event/${e}`));
  assert.ok(a.overdue.some((l) => l.text.includes("Event graphic")));
  assert.equal(b.dueSoon.length, 1);
  assert.ok(b.dueSoon[0].text.includes("Soon post"));
  assert.equal(b.overdue.length, 1); // post-attached graphic goes to the post's owner
  assert.ok(b.overdue[0].text.includes("Post graphic"));
  assert.equal(d.overdue.length, 1); // post with no event and no owner
  assert.equal(d.overdue[0].url, `${BASE}/#calendar`);
  assert.ok(!ds.some((x) => JSON.stringify(x).match(/Archived|Cancelled|Done post|Far post|Finished|Attachment/)));
});

test("overdue keeps to the last 30 days and counts a Ready post whose day passed", async () => {
  const C = "c@grmc.test";
  await post("Month-old post", { owner: C, date: "2026-10-31" });
  await post("Thirty days back", { owner: C, date: "2026-11-01" });
  await post("Ready but unsent", { owner: C, date: "2026-11-29", status: "ready" });
  await post("Scheduled late", { owner: C, date: "2026-11-29", status: "scheduled" });
  await post("Ready soon", { owner: C, date: "2026-12-03", status: "ready" });
  const e = await ev("Fair", { owner: C });
  await media("Month-old graphic", { event: e, date: "2026-10-31" });
  await media("Recent graphic", { event: e, date: "2026-11-01" });

  const c = find(await buildDigests(pool, TODAY, null, BASE, DEF), C)!;
  const overdue = c.overdue.map((l) => l.text).join("\n");
  assert.match(overdue, /Thirty days back/);
  assert.match(overdue, /Ready but unsent/);
  assert.match(overdue, /Recent graphic/);
  assert.doesNotMatch(overdue, /Month-old|Scheduled late/);
  assert.equal(c.overdue.length, 3);
  assert.equal(c.dueSoon.length, 0, "a Ready post due soon is on track");
});

test("a Breeze event whose only post is cancelled has nothing planned", async () => {
  const e = await ev("Carol sing", { source: "breeze", owner: A, start: "2026-12-12" });
  await post("Dropped", { event: e, date: "2026-12-10", status: "cancelled" });
  const a = find(await buildDigests(pool, TODAY, null, BASE, DEF), A)!;
  assert.ok(a.noChecklist.some((l) => l.text.includes("Carol sing")));
});

test("Breeze lines", async () => {
  const since = "2026-11-24T12:00:00Z";
  const fresh = await ev("New one", { source: "breeze", owner: A, start: "2026-12-10", created: "2026-11-25T00:00:00Z" });
  await ev("Old one", { source: "breeze", owner: A, start: "2026-12-10", created: "2026-11-20T00:00:00Z" });
  const gone = await ev("Gone one", { source: "breeze", owner: B, start: "2026-12-15", missing: true, created: "2026-11-20T00:00:00Z" });
  const rep = await ev("Weekly", { source: "breeze", owner: A, start: "2026-12-02", breezeEvent: "bz1", created: "2026-11-20T00:00:00Z" });
  await pool.query("INSERT INTO breeze_series (breeze_event_id, name, calendar_id, mode, became_series_at) VALUES ('bz1','Weekly','10','series','2026-11-26T00:00:00Z')");
  await post("p", { event: rep, date: "2026-12-02" }); // has a post, so not "nothing planned"

  let ds = await buildDigests(pool, TODAY, since, BASE, DEF);
  const a = find(ds, A)!;
  assert.ok(a.newEvents.some((l) => l.url === `${BASE}/#event/${fresh}`));
  assert.ok(a.newEvents.some((l) => l.text.includes("New one")) && !a.newEvents.some((l) => l.text.includes("Old one")));
  assert.equal(a.nowRepeating.length, 1);
  assert.equal(a.nowRepeating[0].url, `${BASE}/#event/${rep}`);
  assert.ok(a.noChecklist.some((l) => l.text.includes("Old one")));
  assert.ok(!a.noChecklist.some((l) => l.text.includes("Weekly")));
  assert.equal(find(ds, B)!.removed[0].url, `${BASE}/#event/${gone}`);

  // First email: only events in the next 30 days, and no "now repeating".
  await ev("Far off", { source: "breeze", owner: A, start: "2027-03-01" });
  ds = await buildDigests(pool, TODAY, null, BASE, DEF);
  const a2 = find(ds, A)!;
  assert.ok(a2.newEvents.some((l) => l.text.includes("Old one")));
  assert.ok(!a2.newEvents.some((l) => l.text.includes("Far off")));
  assert.equal(a2.nowRepeating.length, 0);
});

test("digestText", () => {
  const empty: Digest = { to: A, overdue: [], dueSoon: [], newEvents: [], nowRepeating: [], removed: [], noChecklist: [] };
  assert.equal(digestText(empty), null);
  const l = (text: string) => ({ text, url: `${BASE}/#calendar` });
  const m = digestText({ ...empty, overdue: [l("o1"), l("o2")], dueSoon: [l("d1"), l("d2"), l("d3")], newEvents: [l("n1")], noChecklist: [l("c1")] })!;
  assert.equal(m.subject, "Social posts: 2 overdue, 3 due this week");
  const order = ["Overdue", "Due this week", "New events", "Nothing planned"].map((s) => m.text.indexOf(s));
  assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])));
  assert.ok(!m.text.includes("now repeat") && !m.text.includes("Removed"));
});

async function mailOn() {
  await setSetting(pool, "resend_api_key", "re_x");
  await setSetting(pool, "mail_from", "G <g@example.org>");
  await setSetting(pool, "public_base_url", BASE);
  await setSetting(pool, "default_timezone", "America/New_York");
  await setSetting(pool, "breeze_default_owner", DEF);
}
const stub = (status = 200) => {
  const calls: Array<{ to: string; key: string }> = [];
  const fn = (async (_u: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ to: JSON.parse(init.body).to[0], key: init.headers["idempotency-key"] });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
};
const MON = new Date("2026-11-30T13:10:00Z"); // 08:10 New York

test("digestTick sends per owner, marks the slot, and is idempotent", async () => {
  await mailOn();
  await post("Late", { owner: A, date: "2026-11-20" });
  await post("Later", { owner: B, date: "2026-11-21" });
  const { fn, calls } = stub();
  assert.deepEqual(await digestTick(pool, MON, fn), { sent: 2, failed: 0 });
  assert.deepEqual(calls.map((c) => c.key).sort(), [`digest-2026-11-30-${A}`, `digest-2026-11-30-${B}`]);
  assert.equal(await getSetting(pool, "digest_last_slot"), "2026-11-30");
  assert.equal(await getSetting(pool, "digest_last_sent_at"), MON.toISOString());
  assert.deepEqual(await digestTick(pool, MON, fn), { sent: 0, failed: 0 });
  assert.equal(calls.length, 2);
});

test("digestTick retries a failed send and does nothing without Resend", async () => {
  await post("Late", { owner: A, date: "2026-11-20" });
  const off = stub();
  assert.deepEqual(await digestTick(pool, MON, off.fn), { sent: 0, failed: 0 });
  assert.equal(off.calls.length, 0);

  await mailOn();
  const bad = stub(500);
  assert.deepEqual(await digestTick(pool, MON, bad.fn), { sent: 0, failed: 1 });
  assert.equal(await getSetting(pool, "digest_last_slot"), "");
  assert.equal(await getSetting(pool, "digest_last_sent_at"), "");
  const ok = stub();
  assert.deepEqual(await digestTick(pool, MON, ok.fn), { sent: 1, failed: 0 });
  assert.equal(await getSetting(pool, "digest_last_slot"), "2026-11-30");
});
