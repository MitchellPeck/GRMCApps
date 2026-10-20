import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { getPlayNow, parsePlayNow } from "./play-now";

// Answers the two lookups getPlayNow makes: the settings row and the media row.
function fakePool(
  settings: Record<string, string>,
  media: Record<number, { status: string; title: string } | null>
): Pool {
  return {
    async query(sql: string, params: unknown[]) {
      if (sql.includes("FROM settings")) {
        const value = settings[String(params[0])];
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.includes("FROM media")) {
        const row = media[Number(params[0])];
        return { rows: row ? [{ id: Number(params[0]), ...row }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
}

test("an empty or malformed row is no Play now", () => {
  assert.equal(parsePlayNow("").active, false);
  assert.equal(parsePlayNow("{not json").active, false);
  assert.equal(parsePlayNow(JSON.stringify({ active: false, mediaId: 3 })).active, false);
});

test("a row without a usable media id is no Play now", () => {
  assert.equal(parsePlayNow(JSON.stringify({ active: true, mediaId: 0 })).active, false);
  assert.equal(parsePlayNow(JSON.stringify({ active: true, mediaId: "x" })).active, false);
});

test("a good row is read back", () => {
  const p = parsePlayNow(JSON.stringify({ active: true, mediaId: 7, startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" }));
  assert.deepEqual(p, { active: true, mediaId: 7, title: "", startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" });
});

test("Play now of a deleted or unready item is inactive", async () => {
  const row = JSON.stringify({ active: true, mediaId: 7, startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" });
  assert.equal((await getPlayNow(fakePool({ play_now: row }, { 7: null }))).active, false);
  assert.equal((await getPlayNow(fakePool({ play_now: row }, { 7: { status: "processing", title: "X" } }))).active, false);
});

test("Play now of a ready item carries its title", async () => {
  const row = JSON.stringify({ active: true, mediaId: 7, startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" });
  const p = await getPlayNow(fakePool({ play_now: row }, { 7: { status: "ready", title: "Harvest supper" } }));
  assert.equal(p.active, true);
  assert.equal(p.title, "Harvest supper");
});
