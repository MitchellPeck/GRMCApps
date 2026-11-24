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
