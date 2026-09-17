import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ChargeCodeRow, chargeCodeTree } from "./charge-codes";

const rows: ChargeCodeRow[] = [
  { id: 1, code: "5540", label: "Audio/Video Streaming", parent_id: null, sort: 0, active: true },
  { id: 2, code: "5404", label: "Audio/Video Equipment", parent_id: 1, sort: 0, active: true },
  { id: 3, code: "7000", label: "Marketing", parent_id: null, sort: 1, active: true },
  { id: 4, code: "7040", label: "Photography", parent_id: 3, sort: 0, active: true },
  { id: 5, code: "9300", label: "Security System", parent_id: null, sort: 2, active: true },
  { id: 6, code: "0000", label: "Retired", parent_id: null, sort: 3, active: false },
];

test("chargeCodeTree nests sub-codes under their parent", () => {
  const tree = chargeCodeTree(rows);
  assert.deepEqual(tree.map((c) => c.code), ["5540", "7000", "9300"]);
  assert.deepEqual(tree[0].subs.map((s) => s.code), ["5404"]);
  assert.deepEqual(tree[1].subs.map((s) => s.code), ["7040"]);
});

test("a parent with no sub-codes gets an empty array, never undefined", () => {
  // The UI hides the sub-code field on an empty array; undefined would throw.
  assert.deepEqual(chargeCodeTree(rows)[2].subs, []);
});

test("inactive codes are excluded, and so are their children", () => {
  const tree = chargeCodeTree(rows);
  assert.equal(tree.some((c) => c.code === "0000"), false);
  const orphan: ChargeCodeRow[] = [
    { id: 1, code: "5540", label: "AV", parent_id: null, sort: 0, active: false },
    { id: 2, code: "5404", label: "AV Equip", parent_id: 1, sort: 0, active: true },
  ];
  assert.deepEqual(chargeCodeTree(orphan), []);
});

test("ordering follows sort then code", () => {
  const unsorted: ChargeCodeRow[] = [
    { id: 3, code: "7000", label: "Marketing", parent_id: null, sort: 5, active: true },
    { id: 1, code: "5540", label: "AV", parent_id: null, sort: 1, active: true },
  ];
  assert.deepEqual(chargeCodeTree(unsorted).map((c) => c.code), ["5540", "7000"]);
});
