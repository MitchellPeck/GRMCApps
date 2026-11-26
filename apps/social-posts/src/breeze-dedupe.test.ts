import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BreezeInstance } from "./breeze";
import { clusterCopies, matchKey } from "./pipeline/breeze-dedupe";

let n = 0;
const inst = (seriesId: string, calendarId: string, date: string, name = "Christmas Eve"): BreezeInstance =>
  ({ instanceId: "i" + n++, seriesId, calendarId, name, date, startRaw: date + " 18:00:00" });
const groups = (...xs: BreezeInstance[]) => {
  const m = new Map<string, BreezeInstance[]>();
  for (const x of xs) m.set(x.seriesId, [...(m.get(x.seriesId) ?? []), x]);
  return m;
};

test("matchKey ignores case and extra spaces only", () => {
  assert.equal(matchKey("  Christmas   Eve "), "christmas eve");
  assert.notEqual(matchKey("Christmas Eve"), matchKey("Christmas Eve Service"));
});

test("the same name on the same date on two calendars is one cluster", () => {
  const c = clusterCopies(groups(inst("s1", "10", "2026-12-24"), inst("s2", "20", "2026-12-24")), ["10", "20"]);
  assert.equal(c.length, 1);
  assert.equal(c[0].key, "christmas eve");
  assert.deepEqual(c[0].seriesIds, ["s1", "s2"]);
  assert.deepEqual(c[0].calendarIds, ["10", "20"]);
  assert.equal(c[0].byDate.get("2026-12-24")!.length, 2);
});

test("same name on different dates stays apart", () => {
  const c = clusterCopies(groups(inst("s1", "10", "2026-12-24"), inst("s2", "20", "2026-12-31")), ["10", "20"]);
  assert.equal(c.length, 2);
});

test("different names on the same date stay apart", () => {
  const c = clusterCopies(groups(inst("s1", "10", "2026-12-24"), inst("s2", "20", "2026-12-24", "Carols")), ["10", "20"]);
  assert.equal(c.length, 2);
});

test("weekly series on two calendars sharing dates is one cluster", () => {
  const w = "Sunday Service";
  const c = clusterCopies(groups(
    inst("s1", "10", "2026-12-06", w), inst("s1", "10", "2026-12-13", w), inst("s1", "10", "2026-12-20", w),
    inst("s2", "20", "2026-12-13", w), inst("s2", "20", "2026-12-20", w),
  ), ["10", "20"]);
  assert.equal(c.length, 1);
  assert.deepEqual([...c[0].byDate.keys()], ["2026-12-06", "2026-12-13", "2026-12-20"]);
});

test("joining is transitive", () => {
  const c = clusterCopies(groups(
    inst("A", "10", "2026-01-01"),
    inst("B", "20", "2026-01-01"), inst("B", "20", "2026-01-02"),
    inst("C", "30", "2026-01-02"),
  ), ["10", "20", "30"]);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].seriesIds, ["A", "B", "C"]);
});

test("calendarIds follow the ticked order", () => {
  const c = clusterCopies(groups(inst("s1", "10", "2026-12-24"), inst("s2", "20", "2026-12-24")), ["20", "10"]);
  assert.deepEqual(c[0].calendarIds, ["20", "10"]);
  assert.deepEqual(c[0].byDate.get("2026-12-24")!.map(i => i.calendarId), ["20", "10"]);
});

test("calendars outside the order go last, by id; clusters sort by earliest date then key", () => {
  const c = clusterCopies(groups(
    inst("s1", "99", "2026-12-24"), inst("s2", "50", "2026-12-24"), inst("s3", "10", "2026-12-24"),
    inst("z", "10", "2026-01-05", "Zed"), inst("a", "10", "2026-01-05", "Alpha"),
  ), ["10"]);
  assert.deepEqual(c.map(x => x.key), ["alpha", "zed", "christmas eve"]);
  assert.deepEqual(c[2].calendarIds, ["10", "50", "99"]);
});
