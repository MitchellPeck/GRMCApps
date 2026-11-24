import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { listCalendars, listInstances, parseInstance, loadBreezeConfig, tickedCalendars } from "./breeze";
import { setSetting, getSettingsView } from "./settings";

// tsc doesn't copy JSON, so tests read the fixtures from src/.
const fixture = (n: string) => readFileSync(join(__dirname, "..", "src", "fixtures", n), "utf8");
const cfg = { subdomain: "grmc", apiKey: "SECRETKEY-123" };

function fakeFetch(body: string, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("listCalendars calls /api/events/calendars/list with the Api-Key header", async () => {
  const f = fakeFetch(fixture("breeze-calendars.json"));
  const cals = await listCalendars(cfg, f.fn);
  assert.equal(f.calls[0].url, "https://grmc.breezechms.com/api/events/calendars/list");
  assert.equal(f.calls[0].headers["Api-Key"], "SECRETKEY-123");
  assert.deepEqual(cals[0], { id: "0", name: "Main Calendar" });
  assert.equal(cals.length, 2);
});

test("listInstances passes start, end and category_id and maps the fields", async () => {
  const f = fakeFetch(fixture("breeze-events.json"));
  const out = await listInstances(cfg, "0", "2026-12-01", "2026-12-31", f.fn);
  const u = new URL(f.calls[0].url);
  assert.equal(u.pathname, "/api/events");
  assert.equal(u.searchParams.get("start"), "2026-12-01");
  assert.equal(u.searchParams.get("end"), "2026-12-31");
  assert.equal(u.searchParams.get("category_id"), "0");
  assert.equal(u.searchParams.get("limit"), "500");
  assert.deepEqual(out[0], {
    instanceId: "5001", seriesId: "412", name: "Christmas Eve Service",
    calendarId: "0", date: "2026-12-06", startRaw: "2026-12-06 23:30:00",
  });
});

test("parseInstance keeps the local date", () => {
  const i = parseInstance({ id: "1", event_id: "2", name: "x", category_id: "0", start_datetime: "2026-12-06 23:30:00" });
  assert.equal(i.date, "2026-12-06");
});

test("a non-200 reply throws an error naming Breeze and the status, without the key", async () => {
  const f = fakeFetch("nope SECRETKEY-123", 403);
  await assert.rejects(listCalendars(cfg, f.fn), (e: Error) => {
    assert.ok(e.message.includes("Breeze"));
    assert.ok(e.message.includes("403"));
    assert.ok(!e.message.includes("SECRETKEY-123"));
    return true;
  });
});

test("settings view never returns the key; config and ticked calendars load", async () => {
  const p = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await p.query("DELETE FROM settings WHERE key LIKE 'breeze_%'");
    assert.equal(await loadBreezeConfig(p), null);
    assert.deepEqual(await tickedCalendars(p), []);
    await setSetting(p, "breeze_subdomain", "grmc");
    await setSetting(p, "breeze_api_key", "SECRETKEY-123");
    await setSetting(p, "breeze_calendars", JSON.stringify(["0", "7"]));
    await setSetting(p, "breeze_default_owner", "Pastor Sam");
    assert.deepEqual(await loadBreezeConfig(p), cfg);
    assert.deepEqual(await tickedCalendars(p), ["0", "7"]);
    const view = await getSettingsView(p);
    assert.equal(view.hasBreeze, true);
    assert.equal(view.breezeSubdomain, "grmc");
    assert.deepEqual(view.breezeCalendars, ["0", "7"]);
    assert.equal(view.breezeDefaultOwner, "Pastor Sam");
    assert.ok(!JSON.stringify(view).includes("SECRETKEY-123"));
  } finally {
    await p.query("DELETE FROM settings WHERE key LIKE 'breeze_%'");
    await p.end();
  }
});

test("a 200 reply that is not a list throws instead of reading as empty", async () => {
  const body = JSON.stringify({ success: false, errors: ["bad key"] });
  await assert.rejects(listCalendars(cfg, fakeFetch(body).fn), /unexpected reply/);
  await assert.rejects(listInstances(cfg, "0", "2026-12-01", "2026-12-31", fakeFetch(body).fn), /unexpected reply/);
});

test("listInstances refuses a reply that hit the 500 limit", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: String(i), event_id: "1", name: "x", category_id: "0", start_datetime: "2026-12-06 10:00:00" }));
  await assert.rejects(listInstances(cfg, "0", "2026-12-01", "2026-12-31", fakeFetch(JSON.stringify(rows)).fn), /too many events/);
});

test("listInstances throws on a row without a usable start date, since a dropped row would look like a removal", async () => {
  const rows = [
    { id: "1", event_id: "1", name: "ok", category_id: "0", start_datetime: "2026-12-06 10:00:00" },
    { id: "2", event_id: "1", name: "no date", category_id: "0" },
  ];
  await assert.rejects(listInstances(cfg, "0", "2026-12-01", "2026-12-31", fakeFetch(JSON.stringify(rows)).fn), /without a date we can read/);
  const bad = [{ id: "3", event_id: "1", name: "bad date", category_id: "0", start_datetime: "soon" }];
  await assert.rejects(listInstances(cfg, "0", "2026-12-01", "2026-12-31", fakeFetch(JSON.stringify(bad)).fn), /without a date we can read/);
});

test("an invalid subdomain is rejected on save and treated as not connected", async () => {
  const { default: Fastify } = await import("fastify");
  const { settingsRoutes } = await import("./routes/settings");
  const { pool: appPool } = await import("./db");
  const app = Fastify();
  await app.register(settingsRoutes);
  const p = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await p.query("DELETE FROM settings WHERE key LIKE 'breeze_%'");
    const res = await app.inject({ method: "POST", url: "/api/settings", payload: { breezeSubdomain: "evil.com/x", breezeKey: "K" } });
    assert.equal(res.json().ok, false);
    assert.equal((await p.query("SELECT 1 FROM settings WHERE key LIKE 'breeze_%'")).rowCount, 0, "nothing saved");
    await setSetting(p, "breeze_subdomain", "evil.com");
    await setSetting(p, "breeze_api_key", "K");
    assert.equal(await loadBreezeConfig(p), null);
  } finally {
    await p.query("DELETE FROM settings WHERE key LIKE 'breeze_%'");
    await p.end();
    await app.close();
    await appPool.end();
  }
});
