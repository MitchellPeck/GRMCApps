import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePlaying } from "./choose";

const c = (entryId: number, playlistId: number | null, archived = false, frames = 0) => ({
  entryId,
  playlist: playlistId === null ? null : { id: playlistId, archived },
  frameCount: frames,
});

test("the winner plays when it has something to show", () => {
  assert.deepEqual(choosePlaying([c(1, 10, false, 2), c(2, 20, false, 3)]), { playing: 0, named: 0, nothingPlayable: false });
});

test("an empty or archived winner hands the screen to the next covering entry", () => {
  assert.deepEqual(choosePlaying([c(1, 10, false, 0), c(2, 20, true, 4), c(3, 30, false, 1)]), { playing: 2, named: 2, nothingPlayable: false });
});

test("nothing playable names the first live playlist and plays nothing", () => {
  assert.deepEqual(choosePlaying([c(1, 10, true, 0), c(2, 20, false, 0)]), { playing: null, named: 1, nothingPlayable: true });
});

test("no candidates is simply nothing scheduled", () => {
  assert.deepEqual(choosePlaying([]), { playing: null, named: null, nothingPlayable: false });
});
