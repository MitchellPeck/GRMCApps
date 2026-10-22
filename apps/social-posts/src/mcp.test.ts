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
