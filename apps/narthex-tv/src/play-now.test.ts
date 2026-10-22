import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { getPlayNow, parsePlayNow } from "./play-now";

// Answers the lookups getPlayNow makes: the settings row, and the media or
// playlist row it names.
function fakePool(
  settings: Record<string, string>,
  media: Record<number, { status: string; title: string } | null>,
  playlists: Record<number, { name: string; archived: boolean } | null> = {}
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
      if (sql.includes("FROM playlists")) {
        const row = playlists[Number(params[0])];
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
  assert.deepEqual(p, { active: true, mediaId: 7, playlistId: 0, title: "", startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" });
});

test("Play now of a deleted or failed item is inactive", async () => {
  const row = JSON.stringify({ active: true, mediaId: 7, startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" });
  assert.equal((await getPlayNow(fakePool({ play_now: row }, { 7: null }))).active, false);
  assert.equal((await getPlayNow(fakePool({ play_now: row }, { 7: { status: "failed", title: "X" } }))).active, false);
});

test("Play now survives its item being re-rendered, so fixing a typo does not power-cycle the TV", async () => {
  const row = JSON.stringify({ active: true, mediaId: 7, startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" });
  for (const status of ["pending", "processing"]) {
    const p = await getPlayNow(fakePool({ play_now: row }, { 7: { status, title: "Notice" } }));
    assert.equal(p.active, true, status);
    assert.equal(p.title, "Notice");
  }
});

test("Play now of a ready item carries its title", async () => {
  const row = JSON.stringify({ active: true, mediaId: 7, startedAt: "2026-10-20T15:00:00.000Z", startedBy: "Pat" });
  const p = await getPlayNow(fakePool({ play_now: row }, { 7: { status: "ready", title: "Harvest supper" } }));
  assert.equal(p.active, true);
  assert.equal(p.title, "Harvest supper");
});

test("a playlist row is read back as a playlist Play now", () => {
  const p = parsePlayNow(JSON.stringify({ active: true, playlistId: 4, startedAt: "2026-10-21T15:00:00.000Z", startedBy: "Pat" }));
  assert.equal(p.active, true);
  assert.equal(p.playlistId, 4);
  assert.equal(p.mediaId, 0);
});

test("Play now of a playlist carries its name", async () => {
  const row = JSON.stringify({ active: true, playlistId: 4, startedAt: "2026-10-21T15:00:00.000Z", startedBy: "Pat" });
  const p = await getPlayNow(fakePool({ play_now: row }, {}, { 4: { name: "Sunday loop", archived: false } }));
  assert.equal(p.active, true);
  assert.equal(p.title, "Sunday loop");
});

test("Play now of a deleted or archived playlist is inactive", async () => {
  const row = JSON.stringify({ active: true, playlistId: 4, startedAt: "2026-10-21T15:00:00.000Z", startedBy: "Pat" });
  assert.equal((await getPlayNow(fakePool({ play_now: row }, {}, { 4: null }))).active, false);
  assert.equal((await getPlayNow(fakePool({ play_now: row }, {}, { 4: { name: "Old", archived: true } }))).active, false);
});
