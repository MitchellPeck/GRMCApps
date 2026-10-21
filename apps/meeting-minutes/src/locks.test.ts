import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";
import { createMeeting } from "./meetings";
import { acquireLock, getLock, Lock, lockLive, releaseLock } from "./locks";

const url = process.env.TEST_DATABASE_URL;
const T0 = new Date("2026-10-21T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const A = { email: "a@x", name: "Ann" }, B = { email: "b@x", name: "Bob" };

function lock(over: Partial<Lock> = {}): Lock {
  return { meetingId: 1, email: "a@x", name: "Ann", acquiredAt: T0, heartbeatAt: T0, editedAt: T0, ...over };
}

test("a lock lapses after 2 minutes without a heartbeat or 15 without an edit, but not for idleness while recording", () => {
  assert.equal(lockLive(lock(), at(60_000), false), true);
  assert.equal(lockLive(lock(), at(3 * 60_000), false), false);
  const busy = lock({ heartbeatAt: at(20 * 60_000) });
  assert.equal(lockLive(busy, at(20 * 60_000), false), false, "20 min since the last edit");
  assert.equal(lockLive(busy, at(20 * 60_000), true), true, "recording keeps it");
  assert.equal(lockLive(lock({ heartbeatAt: at(0) }), at(3 * 60_000), true), false, "a closed tab still lets it go");
  assert.equal(lockLive(null, T0, false), false);
});

async function fresh(pool: Pool): Promise<number> {
  await pool.query("DELETE FROM meetings");
  const m = await createMeeting(pool, { title: "Lock", meetingDate: "", location: "", description: "", email: "", name: "" });
  assert.ok(m.ok);
  return m.id;
}

test("one person holds a meeting; the next can take it once it lapses", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const id = await fresh(pool);
    assert.equal((await acquireLock(pool, id, A, { now: T0 })).held, true);
    const refused = await acquireLock(pool, id, B, { now: at(60_000) });
    assert.equal(refused.held, false);
    assert.equal(refused.lock.email, "a@x");
    assert.equal((await acquireLock(pool, id, A, { now: at(90_000) })).held, true, "heartbeat");
    const taken = await acquireLock(pool, id, B, { now: at(90_000 + 3 * 60_000) });
    assert.equal(taken.held, true);
    assert.equal(taken.lock.email, "b@x");
    assert.equal((await getLock(pool, id, at(90_000 + 3 * 60_000)))!.lock.name, "Bob");
  } finally { await pool.end(); }
});

test("releasing only lets go of your own lock", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const id = await fresh(pool);
    await acquireLock(pool, id, A);
    await releaseLock(pool, id, "b@x");
    assert.equal((await acquireLock(pool, id, B)).held, false);
    await releaseLock(pool, id, "a@x");
    assert.equal((await acquireLock(pool, id, B)).held, true);
  } finally { await pool.end(); }
});

test("two people opening a free meeting at once: exactly one gets it", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  try {
    const id = await fresh(pool);
    const [ra, rb] = await Promise.all([acquireLock(pool, id, A), acquireLock(pool, id, B)]);
    assert.equal([ra.held, rb.held].filter(Boolean).length, 1);
  } finally { await pool.end(); }
});

test("an edit keeps the lock from going idle; a heartbeat alone does not", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const id = await fresh(pool);
    await acquireLock(pool, id, A, { now: T0 });
    for (let m = 1; m <= 16; m++) await acquireLock(pool, id, A, { now: at(m * 60_000) }); // heartbeats only
    assert.equal((await getLock(pool, id, at(16 * 60_000)))!.live, false);
    await acquireLock(pool, id, A, { now: at(16 * 60_000), edit: true });
    assert.equal((await getLock(pool, id, at(17 * 60_000)))!.live, true);
  } finally { await pool.end(); }
});

test("while the recording is still processing, the lock isn't lost for idleness", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const id = await fresh(pool);
    await acquireLock(pool, id, A, { now: T0 });
    await pool.query("UPDATE meeting_locks SET heartbeat_at = $2 WHERE meeting_id = $1", [id, at(20 * 60_000)]);
    for (const status of ["recording", "queued", "processing"]) {
      await pool.query("UPDATE meetings SET recording_status = $2 WHERE id = $1", [id, status]);
      assert.equal((await getLock(pool, id, at(20 * 60_000)))!.live, true, status);
    }
    await pool.query("UPDATE meetings SET recording_status = 'done' WHERE id = $1", [id]);
    assert.equal((await getLock(pool, id, at(20 * 60_000)))!.live, false);
  } finally { await pool.end(); }
});

test("a lock released mid-acquire is simply taken", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const id = await fresh(pool);
    await acquireLock(pool, id, A);
    const [r] = await Promise.all([acquireLock(pool, id, B), releaseLock(pool, id, "a@x")]);
    assert.ok(r.lock, "no crash");
  } finally { await pool.end(); }
});
