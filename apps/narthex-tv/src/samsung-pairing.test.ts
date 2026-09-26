import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { EVENT_CONNECT, EVENT_UNAUTHORIZED, SamsungDeps, SamsungSocket } from "./samsung";
import { pairingStatus, resetPairing, startPairing } from "./samsung-pairing";

/** A settings table, as far as this code can tell. */
function fakePool() {
  const rows = new Map<string, string>();
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (/insert into settings/i.test(sql)) {
        rows.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      const key = String(params[0]);
      return { rows: rows.has(key) ? [{ value: rows.get(key) }] : [] };
    },
  } as unknown as Pool;
  return { pool, rows };
}

class FakeTv implements SamsungSocket {
  private message: (raw: string) => void = () => {};
  send() {}
  close() {}
  onMessage(h: (raw: string) => void) { this.message = h; }
  onError() {}
  onClose() {}
  says(event: string, data: Record<string, unknown> = {}) {
    this.message(JSON.stringify({ event, data }));
  }
}

function harness() {
  const tv = new FakeTv();
  const deps: SamsungDeps = {
    open() { return tv; },
    setTimer() { return { cancel() {} }; },
  };
  return { tv, deps };
}

const settled = () => new Promise((r) => setImmediate(r));

test("pairing answers at once and reports waiting", async () => {
  // The person has to walk to the television. If the HTTP request waited for
  // that, a proxy would give up long before they did.
  resetPairing();
  const { pool } = fakePool();
  const { deps } = harness();
  assert.deepEqual(startPairing(pool, "192.168.1.50", "Narthex TV", deps), { ok: true });
  assert.equal(pairingStatus().state, "waiting");
});

test("pressing Allow stores the token", async () => {
  resetPairing();
  const { pool, rows } = fakePool();
  const { tv, deps } = harness();
  startPairing(pool, "192.168.1.50", "Narthex TV", deps);
  tv.says(EVENT_CONNECT, { token: "58527546" });
  await settled();
  await settled();
  assert.equal(pairingStatus().state, "paired");
  assert.equal(rows.get("samsung_token"), "58527546");
  assert.equal(rows.get("samsung_host"), "192.168.1.50");
  assert.ok(rows.get("samsung_paired_at"));
});

test("pressing Deny stores nothing and says it was refused", async () => {
  resetPairing();
  const { pool, rows } = fakePool();
  const { tv, deps } = harness();
  startPairing(pool, "192.168.1.50", "Narthex TV", deps);
  tv.says(EVENT_UNAUTHORIZED);
  await settled();
  const status = pairingStatus();
  assert.equal(status.state, "failed");
  assert.equal(status.state === "failed" && status.denied, true);
  assert.equal(rows.get("samsung_token"), undefined);
});

test("a bad address is refused before the television is dialled", () => {
  resetPairing();
  const { pool } = fakePool();
  let opened = 0;
  const deps: SamsungDeps = {
    open() { opened++; throw new Error("should not happen"); },
    setTimer() { return { cancel() {} }; },
  };
  const result = startPairing(pool, "http://192.168.1.50:8002/x", "Narthex TV", deps);
  assert.equal(result.ok, false);
  assert.equal(opened, 0);
  assert.equal(pairingStatus().state, "idle");
});

test("a second attempt while one is waiting is refused", () => {
  // The set shows one prompt. Starting another replaces it with a prompt the
  // first attempt can no longer hear the answer to.
  resetPairing();
  const { pool } = fakePool();
  const { deps } = harness();
  assert.equal(startPairing(pool, "192.168.1.50", "Narthex TV", deps).ok, true);
  const second = startPairing(pool, "192.168.1.51", "Narthex TV", deps);
  assert.equal(second.ok, false);
});

test("a failed attempt does not block the next one", async () => {
  resetPairing();
  const { pool } = fakePool();
  const { tv, deps } = harness();
  startPairing(pool, "192.168.1.50", "Narthex TV", deps);
  tv.says(EVENT_UNAUTHORIZED);
  await settled();
  assert.equal(startPairing(pool, "192.168.1.50", "Narthex TV", deps).ok, true);
});
