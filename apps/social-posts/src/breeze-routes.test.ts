import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import Fastify, { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { pipelineRoutes } from "./routes/pipeline";
import { settingsRoutes } from "./routes/settings";
import { createContent, createEvent } from "./pipeline/repo";
import { getSetting, setSetting } from "./settings";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let app: FastifyInstance;
let sent: Array<{ url: string; body: any }> = [];
const fakeFetch = (async (url: any, init: any) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
}) as unknown as typeof fetch;

before(async () => {
  await pool.query("DROP TABLE IF EXISTS gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors, metricool_links, media_assets, content_items, recurrences, events, breeze_links, breeze_series, checklist_rules");
  await pool.query(SCHEMA_SQL);
  app = Fastify();
  await app.register(pipelineRoutes, { db: pool, fetchFn: fakeFetch });
  await app.register(settingsRoutes, { db: pool });
  await app.ready();
});
beforeEach(async () => {
  sent = [];
  await pool.query("DELETE FROM checklist_rules");
  await pool.query("DELETE FROM breeze_series");
  await pool.query("DELETE FROM media_assets");
  await pool.query("DELETE FROM content_items");
  await pool.query("DELETE FROM events");
  await pool.query("DELETE FROM settings WHERE key LIKE 'breeze_%' OR key LIKE 'digest_%' OR key IN ('resend_api_key','mail_from','public_base_url')");
});
after(async () => { await app.close(); await pool.query("DELETE FROM events"); await pool.end(); });

const call = async (method: any, url: string, payload?: object, email = "me@x.org") =>
  (await app.inject({ method, url, payload, headers: { "x-auth-email": email } })).json() as any;

test("checklist rule round trip and parse errors", async () => {
  const bad = await call("POST", "/api/pipeline/checklist-rules", { match: "sideways" });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
  const body = { match: "name", namePattern: "welcome", items: [{ kind: "post", title: "Promo", platforms: ["instagram"], daysBefore: 7 }] };
  const made = await call("POST", "/api/pipeline/checklist-rules", body);
  if (!made.ok) assert.fail("create failed: " + made.error + " — adjust the fixture to checklist.ts's shape");
  const id = made.rule.id;
  assert.equal((await call("GET", "/api/pipeline/checklist-rules")).rules.length, 1);
  const patched = await call("PATCH", `/api/pipeline/checklist-rules/${id}`, { namePattern: "welcome2" });
  assert.ok(patched.ok, patched.error);
  assert.equal(patched.rule.namePattern, "welcome2");
  assert.ok((await call("DELETE", `/api/pipeline/checklist-rules/${id}`)).ok);
  assert.equal((await call("GET", "/api/pipeline/checklist-rules")).rules.length, 0);
});

test("series mode patch rejects single", async () => {
  await pool.query("INSERT INTO breeze_series (breeze_event_id, name, calendar_id, mode, mode_source) VALUES ('b1','Choir','c1','each','auto')");
  assert.equal((await call("PATCH", "/api/pipeline/breeze/series/b1", { mode: "single" })).ok, false);
  assert.ok((await call("PATCH", "/api/pipeline/breeze/series/b1", { mode: "ignore" })).ok);
  const list = await call("GET", "/api/pipeline/breeze/series");
  assert.equal(list.series[0].mode, "ignore");
});

test("apply-rules refuses an event that has posts", async () => {
  const ev = await createEvent(pool, { name: "Has posts", startDate: "2026-12-10" });
  await createContent(pool, { title: "p", eventId: ev.id }, "t@x");
  const r = await call("POST", `/api/pipeline/events/${ev.id}/apply-rules`);
  assert.equal(r.ok, false);
});

test("event media create returns an event-level graphic", async () => {
  const ev = await createEvent(pool, { name: "Cover", startDate: "2026-12-10" });
  const r = await call("POST", `/api/pipeline/events/${ev.id}/media`, { description: "FB cover", type: "graphic", graphicType: "fb-event-cover" });
  assert.ok(r.ok, r.error);
  assert.equal(r.media.onEvent, true);
});

test("breeze calendars: not connected is ok:false", async () => {
  const r = await call("GET", "/api/pipeline/breeze/calendars");
  assert.equal(r.ok, false);
});

test("breeze sync with nothing connected reports skipped", async () => {
  const r = await call("POST", "/api/pipeline/breeze/sync");
  assert.ok(r.ok);
  assert.equal(r.report.skipped, "not-connected");
});

test("saving Breeze settings defaults the owner to the signed-in user, once", async () => {
  assert.ok((await call("POST", "/api/settings", { breezeSubdomain: "grmc" }, "Boss@X.org")).ok);
  assert.equal(await getSetting(pool, "breeze_default_owner"), "Boss@X.org");
  assert.ok((await call("POST", "/api/settings", { breezeSubdomain: "grmc" }, "other@x.org")).ok);
  assert.equal(await getSetting(pool, "breeze_default_owner"), "Boss@X.org");
  // Unrelated saves don't claim it.
  await pool.query("DELETE FROM settings WHERE key = 'breeze_default_owner'");
  await call("POST", "/api/settings", { defaultPostTime: "09:00" }, "other@x.org");
  assert.equal(await getSetting(pool, "breeze_default_owner"), "");
});

test("saving ticked calendars also keeps their names, for when Breeze can't be reached", async () => {
  assert.ok((await call("POST", "/api/settings", { breezeCalendars: ["10"], breezeCalendarNames: { "10": "Church Events", "20": "Youth" } })).ok);
  assert.deepEqual((await call("GET", "/api/settings")).breezeCalendarNames, { "10": "Church Events", "20": "Youth" });
  assert.equal((await call("POST", "/api/settings", { breezeCalendarNames: { "10": 5 } })).ok, false);
});

test("digest test sends only the signed-in user's digest and leaves the slot alone", async () => {
  await setSetting(pool, "resend_api_key", "k");
  await setSetting(pool, "mail_from", "a@x.org");
  await setSetting(pool, "public_base_url", "https://x.test");
  const empty = await call("POST", "/api/pipeline/digest/test");
  assert.ok(empty.ok);
  assert.match(empty.message, /nothing/i);
  assert.equal(sent.length, 0);

  await createEvent(pool, { name: "Mine", startDate: "2026-12-10" });
  await pool.query("UPDATE events SET source='breeze', breeze_event_id='z', breeze_instance_id='i', owner_email='ME@x.org'");
  await pool.query("INSERT INTO events (name, start_date, source, breeze_event_id, breeze_instance_id, owner_email) VALUES ('Theirs', '2026-12-11', 'breeze', 'y', 'j', 'other@x.org')");
  const r = await call("POST", "/api/pipeline/digest/test");
  assert.ok(r.ok, r.error);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.to.toString().toLowerCase().includes("me@x.org"), true);
  assert.ok(!JSON.stringify(sent[0].body).includes("Theirs"));
  assert.equal(await getSetting(pool, "digest_last_slot"), "");
  assert.equal(await getSetting(pool, "digest_last_sent_at"), "");
});
