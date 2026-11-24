import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { handleMessage, PROTOCOL_VERSIONS } from "./mcp";

// The protocol itself never touches the database.
const ctx = { db: null as unknown as Pool, email: "a@x.org" };
const send = (m: object) => handleMessage({ jsonrpc: "2.0", ...m }, ctx) as Promise<any>;

test("initialize answers the client's version when it's one we speak", async () => {
  const r = await send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.deepEqual(r.result.capabilities, { tools: {} });
  const old = await send({ id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  assert.equal(old.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test("notifications get no answer; unknown methods and tools are errors", async () => {
  assert.equal(await send({ method: "notifications/initialized" }), null);
  assert.equal((await send({ id: 3, method: "resources/list" })).error.code, -32601);
  assert.equal((await send({ id: 4, method: "tools/call", params: { name: "delete_everything" } })).error.code, -32602);
  assert.equal((await handleMessage("nonsense", ctx) as any).error.code, -32600);
  assert.deepEqual((await send({ id: 5, method: "ping" })).result, {});
});

test("tools are listed with schemas, and only the writers aren't read-only", async () => {
  const { tools } = (await send({ id: 6, method: "tools/list" })).result;
  const writers = tools.filter((t: any) => !t.annotations.readOnlyHint).map((t: any) => t.name);
  assert.deepEqual(writers.sort(), ["create_post", "update_post"]);
  for (const t of tools) assert.equal(t.inputSchema.type, "object", t.name);
  assert.ok(!tools.some((t: any) => /delete/.test(t.name)), "nothing deletes");
});

test("list_media includes event-level graphics, and list_events carries Breeze fields", async () => {
  const { SCHEMA_SQL } = await import("./schema");
  const { createEvent, createEventMedia } = await import("./pipeline/repo");
  const { addDays } = await import("./dates");
  const { referenceDate } = await import("./schedule");
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await db.query(SCHEMA_SQL);
    const today = await referenceDate(db);
    const ev = await createEvent(db, { name: "MCP graphic event", startDate: addDays(today, 20) });
    const m = await createEventMedia(db, ev.id, { description: "Cover", type: "graphic", graphicType: "fb-event-cover", gatherDate: addDays(today, 10) });
    assert.ok(m.ok);
    const c = { db, email: "a@x.org" };
    const call = (name: string, args = {}) => handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, c) as Promise<any>;
    const media = JSON.parse((await call("list_media")).result.content[0].text).media;
    const g = media.find((x: any) => x.eventId === ev.id);
    assert.ok(g, "event-level graphic listed");
    assert.equal(g.onEvent, true);
    assert.equal(g.graphicType, "fb-event-cover");
    const events = JSON.parse((await call("list_events")).result.content[0].text).events;
    const e = events.find((x: any) => x.id === ev.id);
    assert.equal(e.source, "manual");
    assert.equal(e.breezeMissingSince, null);
    await db.query("DELETE FROM events WHERE id = $1", [ev.id]);
  } finally { await db.end(); }
});
