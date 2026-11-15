import { test } from "node:test";
import assert from "node:assert/strict";
import { planBulkDelete } from "./bulk-delete";

const rows = [
  { id: 1, title: "A", uploaded_by_email: "me@x.org" },
  { id: 2, title: "B", uploaded_by_email: "ME@x.org" },
  { id: 3, title: "C", uploaded_by_email: "other@x.org" },
];

test("deletes your own items and refuses other people's without manage", () => {
  const plan = planBulkDelete({ rows, requested: [1, 2, 3], email: "me@x.org", manage: false, usage: new Map(), force: false });
  assert.deepEqual(plan.deletable, [1, 2]);
  assert.deepEqual(plan.notYours, [3]);
  assert.deepEqual(plan.inUse, []);
});

test("manage can delete anyone's", () => {
  const plan = planBulkDelete({ rows, requested: [1, 3], email: "me@x.org", manage: true, usage: new Map(), force: false });
  assert.deepEqual(plan.deletable, [1, 3]);
  assert.deepEqual(plan.notYours, []);
});

test("items still in a playlist are held back unless forced", () => {
  const usage = new Map([[2, ["Funeral"]]]);
  const held = planBulkDelete({ rows, requested: [1, 2], email: "me@x.org", manage: false, usage, force: false });
  assert.deepEqual(held.deletable, [1]);
  assert.deepEqual(held.inUse, [{ id: 2, playlists: ["Funeral"] }]);

  const forced = planBulkDelete({ rows, requested: [1, 2], email: "me@x.org", manage: false, usage, force: true });
  assert.deepEqual(forced.deletable, [1, 2]);
  assert.deepEqual(forced.inUse, []);
});

test("ids that no longer exist are reported as missing, not errors", () => {
  const plan = planBulkDelete({ rows, requested: [1, 99], email: "me@x.org", manage: false, usage: new Map(), force: false });
  assert.deepEqual(plan.deletable, [1]);
  assert.deepEqual(plan.missing, [99]);
});
