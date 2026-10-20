import { test } from "node:test";
import assert from "node:assert/strict";
import { describeEntries, resolveSchedule, scheduleCoverage, ScheduleEntry, validateEntry } from "./schedule";

const CHI = "America/Chicago";

function entry(over: Partial<ScheduleEntry>): ScheduleEntry {
  return {
    id: 1, playlistId: 10, mode: "window", label: "",
    startsAt: null, endsAt: null, days: [], startTime: "", endTime: "",
    effectiveFrom: null, effectiveTo: null, priority: 0, enabled: true,
    ...over,
  };
}

const at = (iso: string) => new Date(iso);

test("a window plays only between its start and its end", () => {
  const e = entry({ id: 1, mode: "window", startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  assert.equal(resolveSchedule([e], at("2026-01-15T09:59:00Z"), CHI).entry, null);
  assert.equal(resolveSchedule([e], at("2026-01-15T10:30:00Z"), CHI).entry?.id, 1);
  // The end is exclusive: at exactly 11:00 it is over.
  assert.equal(resolveSchedule([e], at("2026-01-15T11:00:00Z"), CHI).entry, null);
});

test("the window's own end is the next boundary while it is on", () => {
  const special = entry({ id: 2, mode: "window", startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const r = resolveSchedule([special], at("2026-01-15T10:30:00Z"), CHI);
  assert.equal(r.changesAt?.toISOString(), "2026-01-15T11:00:00.000Z");
});

test("a recurring Sunday morning slot follows the clock through a DST change", () => {
  const sunday = entry({ id: 3, mode: "recurring", days: [0], startTime: "08:00", endTime: "12:30" });

  // January, CST (UTC-6): 08:30 local is 14:30Z.
  assert.equal(resolveSchedule([sunday], at("2026-01-11T14:30:00Z"), CHI).entry?.id, 3);
  assert.equal(resolveSchedule([sunday], at("2026-01-11T13:30:00Z"), CHI).entry, null);

  // March, CDT (UTC-5): 08:30 local is 13:30Z. A fixed offset would miss this.
  assert.equal(resolveSchedule([sunday], at("2026-03-15T13:30:00Z"), CHI).entry?.id, 3);
  assert.equal(resolveSchedule([sunday], at("2026-03-15T14:30:00Z"), CHI).entry?.id, 3);

  // Monday is not Sunday.
  assert.equal(resolveSchedule([sunday], at("2026-01-12T14:30:00Z"), CHI).entry, null);
});

test("a recurring entry with no days set runs every day", () => {
  const daily = entry({ id: 4, mode: "recurring", days: [], startTime: "09:00", endTime: "10:00" });
  for (const day of ["2026-01-11", "2026-01-12", "2026-01-17"]) {
    assert.equal(resolveSchedule([daily], at(`${day}T15:30:00Z`), CHI).entry?.id, 4, day);
  }
});

test("a recurring window that crosses midnight is still on after midnight", () => {
  const overnight = entry({ id: 5, mode: "recurring", days: [6], startTime: "22:00", endTime: "02:00" });
  // Saturday 22:30 CST = Sunday 04:30Z.
  assert.equal(resolveSchedule([overnight], at("2026-01-18T04:30:00Z"), CHI).entry?.id, 5);
  // Sunday 01:30 CST = 07:30Z — still the Saturday occurrence.
  assert.equal(resolveSchedule([overnight], at("2026-01-18T07:30:00Z"), CHI).entry?.id, 5);
  // Sunday 02:30 CST = 08:30Z — over.
  assert.equal(resolveSchedule([overnight], at("2026-01-18T08:30:00Z"), CHI).entry, null);
});

test("effective dates bound which occurrences of a recurring entry fire", () => {
  const advent = entry({
    id: 6, mode: "recurring", days: [0], startTime: "08:00", endTime: "12:30",
    effectiveFrom: "2026-01-04", effectiveTo: "2026-01-11",
  });
  assert.equal(resolveSchedule([advent], at("2026-01-04T14:30:00Z"), CHI).entry?.id, 6);
  assert.equal(resolveSchedule([advent], at("2026-01-11T14:30:00Z"), CHI).entry?.id, 6);
  assert.equal(resolveSchedule([advent], at("2026-01-18T14:30:00Z"), CHI).entry, null);
});

test("priority decides between two bounded entries that overlap", () => {
  const routine = entry({ id: 7, playlistId: 10, mode: "recurring", days: [0], startTime: "08:00", endTime: "12:30" });
  const funeral = entry({
    id: 8, playlistId: 20, mode: "window", priority: 10,
    startsAt: "2026-01-11T15:00:00Z", endsAt: "2026-01-11T17:00:00Z",
  });
  assert.equal(resolveSchedule([routine, funeral], at("2026-01-11T14:30:00Z"), CHI).entry?.id, 7);
  assert.equal(resolveSchedule([routine, funeral], at("2026-01-11T15:30:00Z"), CHI).entry?.id, 8);
});

test("a disabled entry never plays", () => {
  const e = entry({ id: 9, mode: "window", enabled: false, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  assert.equal(resolveSchedule([e], at("2026-01-15T10:30:00Z"), CHI).entry, null);
});

test("describeEntries marks an overlapped window and an upcoming one", () => {
  const a = entry({ id: 1, priority: 0, startsAt: "2026-02-01T00:00:00Z", endsAt: "2026-02-28T00:00:00Z" });
  const b = entry({ id: 2, priority: 5, startsAt: "2026-02-10T00:00:00Z", endsAt: "2026-02-20T00:00:00Z" });
  const later = entry({ id: 3, startsAt: "2026-03-01T00:00:00Z", endsAt: "2026-03-02T00:00:00Z" });

  const states = new Map(
    describeEntries([a, b, later], at("2026-02-15T00:00:00Z"), CHI).map((s) => [s.id, s])
  );
  assert.equal(states.get(1)?.state, "superseded");
  assert.equal(states.get(2)?.state, "active");
  assert.equal(states.get(3)?.state, "upcoming");
  assert.equal(states.get(3)?.nextStart?.toISOString(), "2026-03-01T00:00:00.000Z");
});

test("describeEntries reports a recurring entry's next airing", () => {
  const sunday = entry({ id: 3, mode: "recurring", days: [0], startTime: "08:00", endTime: "12:30" });
  const [status] = describeEntries([sunday], at("2026-01-12T18:00:00Z"), CHI);
  assert.equal(status.state, "upcoming");
  // The following Sunday, 08:00 CST.
  assert.equal(status.nextStart?.toISOString(), "2026-01-18T14:00:00.000Z");
});

test("validateEntry refuses entries that could never play", () => {
  assert.equal(validateEntry({ mode: "window", playlistId: 0 }).ok, false);
  assert.equal(validateEntry({ mode: "window", playlistId: 1, startsAt: null }).ok, false);
  assert.equal(
    validateEntry({ mode: "window", playlistId: 1, startsAt: "2026-01-15T11:00:00Z", endsAt: "2026-01-15T10:00:00Z" }).ok,
    false
  );
  assert.equal(
    validateEntry({ mode: "window", playlistId: 1, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" }).ok,
    true
  );
  assert.equal(validateEntry({ mode: "recurring", playlistId: 1, startTime: "08:00", endTime: "12:30", days: [0] }).ok, true);
  assert.equal(validateEntry({ mode: "recurring", playlistId: 1, startTime: "8am", endTime: "12:30" }).ok, false);
  assert.equal(
    validateEntry({ mode: "recurring", playlistId: 1, startTime: "08:00", endTime: "12:30", days: [7] }).ok,
    false
  );
  assert.equal(
    validateEntry({
      mode: "recurring", playlistId: 1, startTime: "08:00", endTime: "12:30",
      effectiveFrom: "2026-02-01", effectiveTo: "2026-01-01",
    }).ok,
    false
  );
});

test("validation rejects until_next and windows without an end", () => {
  assert.equal(validateEntry({ mode: "until_next" as any, playlistId: 1, startsAt: "2026-01-15T10:00:00Z" }).ok, false);
  assert.equal(validateEntry({ mode: "window", playlistId: 1, startsAt: "2026-01-15T10:00:00Z", endsAt: null }).ok, false);
  assert.equal(validateEntry({ mode: "window", playlistId: 1, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T10:00:00Z" }).ok, false);
});

test("candidates lists every covering entry in winning order", () => {
  const low = entry({ id: 1, priority: 0, startsAt: "2026-01-15T09:00:00Z", endsAt: "2026-01-15T12:00:00Z" });
  const high = entry({ id: 2, priority: 5, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const r = resolveSchedule([low, high], at("2026-01-15T10:30:00Z"), CHI);
  assert.deepEqual(r.candidates.map((e) => e.id), [2, 1]);
  assert.equal(r.entry?.id, 2);
});

test("coverage is off with nothing scheduled and names the next start", () => {
  const e = entry({ startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const c = scheduleCoverage([e], at("2026-01-15T09:00:00Z"), CHI);
  assert.equal(c.on, false);
  assert.equal(c.changesAt?.toISOString(), "2026-01-15T10:00:00.000Z");
});

test("back-to-back and overlapping entries are one stretch", () => {
  const a = entry({ id: 1, playlistId: 10, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const b = entry({ id: 2, playlistId: 20, startsAt: "2026-01-15T11:00:00Z", endsAt: "2026-01-15T12:00:00Z" });
  const c = entry({ id: 3, playlistId: 30, startsAt: "2026-01-15T11:30:00Z", endsAt: "2026-01-15T13:00:00Z" });
  const cov = scheduleCoverage([a, b, c], at("2026-01-15T10:30:00Z"), CHI);
  assert.equal(cov.on, true);
  assert.equal(cov.changesAt?.toISOString(), "2026-01-15T13:00:00.000Z");
});

test("an overnight recurring entry keeps coverage on past midnight", () => {
  // Thursday 2026-01-15, 22:00-02:00 Chicago (04:00-08:00Z next day)
  const night = entry({ mode: "recurring", days: [4], startTime: "22:00", endTime: "02:00" });
  const cov = scheduleCoverage([night], at("2026-01-16T07:00:00Z"), CHI); // 01:00 Friday local
  assert.equal(cov.on, true);
  assert.equal(cov.changesAt?.toISOString(), "2026-01-16T08:00:00.000Z");
});

test("disabled entries and dates outside effective bounds give no coverage", () => {
  const off = entry({ enabled: false, startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const bounded = entry({ id: 2, mode: "recurring", days: [], startTime: "09:00", endTime: "17:00", effectiveFrom: "2026-02-01" });
  assert.equal(scheduleCoverage([off, bounded], at("2026-01-15T16:30:00Z"), CHI).on, false);
});

test("no entries at all is off with no next change", () => {
  assert.deepEqual(scheduleCoverage([], at("2026-01-15T10:00:00Z"), CHI), { on: false, changesAt: null });
});
