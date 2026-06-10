import { strict as assert } from "node:assert";
import { Pool } from "pg";
import { PgSessionStore } from "./session-store";

// Run with: node --test (after build) — see Step 4 for the exact command.
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const store = new PgSessionStore(pool);

function set(sid: string, sess: any): Promise<void> {
  return new Promise((res, rej) => store.set(sid, sess, (e) => (e ? rej(e) : res())));
}
function get(sid: string): Promise<any> {
  return new Promise((res, rej) => store.get(sid, (e, s) => (e ? rej(e) : res(s))));
}
function destroy(sid: string): Promise<void> {
  return new Promise((res, rej) => store.destroy(sid, (e) => (e ? rej(e) : res())));
}

async function main() {
  const sess = { cookie: { expires: new Date(Date.now() + 60000).toISOString() }, userId: "u1" };
  await set("test-sid", sess);
  const loaded = await get("test-sid");
  assert.equal(loaded.userId, "u1", "stored session should round-trip");

  await destroy("test-sid");
  const gone = await get("test-sid");
  assert.equal(gone, null, "destroyed session should be null");

  await pool.end();
  console.log("session-store tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
