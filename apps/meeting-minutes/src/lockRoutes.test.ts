// Route-level tests: the real meeting routes, driven with fastify.inject()
// against the test database. config is shared by reference and db.ts builds its
// pool on first import, so point it at TEST_DATABASE_URL before importing.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { config } from "./config";

const url = process.env.TEST_DATABASE_URL;
if (url) config.databaseUrl = url;

let app: any = null, pool: any = null;
async function setup() {
  if (app) return;
  ({ pool } = await import("./db"));
  const Fastify = (await import("fastify")).default;
  const { meetingsRoutes } = await import("./routes/meetings");
  app = Fastify();
  await app.register(meetingsRoutes);
}
after(async () => { if (app) await app.close(); if (pool) await pool.end(); });

const as = (email: string, name: string) => ({ "x-auth-email": email, "x-auth-name": name });
const A = as("a@x", "Ann"), B = as("b@x", "Bob");

async function meetingWithItem() {
  await pool.query("DELETE FROM meetings");
  const id = Number((await pool.query("INSERT INTO meetings (title) VALUES ('Locked') RETURNING id")).rows[0].id);
  const item = Number((await pool.query("INSERT INTO agenda_items (meeting_id, title) VALUES ($1, 'Budget') RETURNING id", [id])).rows[0].id);
  const rec = Number((await pool.query(
    "INSERT INTO meeting_recordings (meeting_id, storage_path) VALUES ($1, '/tmp/none-lock-test.webm') RETURNING id", [id])).rows[0].id);
  return { id, item, rec };
}

test("the first editor holds the meeting and everyone else's writes are refused", { skip: !url }, async () => {
  await setup();
  const { id, item, rec } = await meetingWithItem();
  const first = await app.inject({ method: "PATCH", url: `/api/meetings/${id}`, headers: A, payload: { location: "Hall" } });
  assert.equal(first.statusCode, 200);

  const refused = await app.inject({ method: "PATCH", url: `/api/meetings/${id}`, headers: B, payload: { location: "Barn" } });
  assert.equal(refused.statusCode, 423);
  assert.deepEqual(JSON.parse(refused.body), { ok: false, locked: true, holder: "Ann", error: "Ann is editing this meeting." });

  const viaItem = await app.inject({ method: "PATCH", url: `/api/items/${item}`, headers: B, payload: { notes: "x" } });
  assert.equal(viaItem.statusCode, 423, "an item write finds its meeting");

  const viaRecording = await app.inject({ method: "POST", url: `/api/meeting-recordings/${rec}/reprocess`, headers: B });
  assert.equal(viaRecording.statusCode, 423, "a recording write finds its meeting");

  const chunk = await app.inject({ method: "POST", url: `/api/meeting-recordings/${rec}/chunk`, headers: B, payload: "" });
  assert.notEqual(chunk.statusCode, 423, "recording uploads are never refused");

  const location = (await pool.query("SELECT location FROM meetings WHERE id = $1", [id])).rows[0].location;
  assert.equal(location, "Hall");
});

test("lock, heartbeat and release through the API", { skip: !url }, async () => {
  await setup();
  const { id } = await meetingWithItem();
  const a = JSON.parse((await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: A })).body);
  assert.deepEqual(a, { ok: true, held: true, holder: { email: "a@x", name: "Ann" } });
  const b = JSON.parse((await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: B })).body);
  assert.deepEqual(b, { ok: true, held: false, holder: { email: "a@x", name: "Ann" } });

  const seen = JSON.parse((await app.inject({ url: `/api/meetings/${id}`, headers: B })).body);
  assert.deepEqual(seen.lock, { held: false, holder: { email: "a@x", name: "Ann" } });

  await app.inject({ method: "DELETE", url: `/api/meetings/${id}/lock`, headers: A });
  const b2 = JSON.parse((await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: B })).body);
  assert.equal(b2.held, true);
});

test("creating a meeting and reading one are never locked", { skip: !url }, async () => {
  await setup();
  const { id } = await meetingWithItem();
  await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: A });
  assert.equal((await app.inject({ url: `/api/meetings/${id}`, headers: B })).statusCode, 200);
  const made = await app.inject({ method: "POST", url: "/api/meetings", headers: B, payload: { title: "New" } });
  assert.equal(made.statusCode, 200);
});

const old = new Date(Date.now() - 20 * 60_000);
async function lockedByAnnLongAgo(id: number) {
  await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: A });
  await pool.query("UPDATE meeting_locks SET edited_at = $2 WHERE meeting_id = $1", [id, old]);
}

test("recording uploads keep the recorder's lock alive and never take someone else's", { skip: !url }, async () => {
  await setup();
  const { id, rec } = await meetingWithItem();
  await lockedByAnnLongAgo(id);
  await app.inject({ method: "POST", url: `/api/meeting-recordings/${rec}/marker`, headers: A, payload: { itemId: 0, atSeconds: 1 } });
  const edited = (await pool.query("SELECT edited_at FROM meeting_locks WHERE meeting_id = $1", [id])).rows[0].edited_at;
  assert.ok(new Date(edited).getTime() > old.getTime() + 60_000, "the recorder's upload counts as activity");
  await app.inject({ method: "POST", url: `/api/meeting-recordings/${rec}/marker`, headers: B, payload: { itemId: 0, atSeconds: 2 } });
  assert.equal((await pool.query("SELECT email FROM meeting_locks WHERE meeting_id = $1", [id])).rows[0].email, "a@x");
});

test("a heartbeat while typing or recording counts as activity; a bare one doesn't", { skip: !url }, async () => {
  await setup();
  const { id } = await meetingWithItem();
  await lockedByAnnLongAgo(id);
  await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: A, payload: {} });
  const bare = JSON.parse((await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: B })).body);
  assert.equal(bare.held, true, "idle lapsed: Bob takes it");
  await lockedByAnnLongAgo(id);
  await pool.query("UPDATE meeting_locks SET email = 'a@x', name = 'Ann' WHERE meeting_id = $1", [id]);
  await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: A, payload: { active: true } });
  const busy = JSON.parse((await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: B })).body);
  assert.equal(busy.held, false, "Ann is typing: Bob can't take it");
});

test("uploading a topic's recorded audio is never refused by the lock", { skip: !url }, async () => {
  await setup();
  const { id, item } = await meetingWithItem();
  await app.inject({ method: "POST", url: `/api/meetings/${id}/lock`, headers: A });
  const r = await app.inject({ method: "POST", url: `/api/items/${item}/transcribe`, headers: B, payload: "" });
  assert.notEqual(r.statusCode, 423);
});
