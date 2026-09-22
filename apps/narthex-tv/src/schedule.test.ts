import { test } from "node:test";
import assert from "node:assert/strict";
import { describeEntries, resolveSchedule, ScheduleEntry, validateEntry } from "./schedule";

const CHI = "America/Chicago";

function entry(over: Partial<ScheduleEntry>): ScheduleEntry {
  return {
    id: 1, playlistId: 10, mode: "until_next", label: "",
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

test("an open-ended entry keeps playing until a later one starts", () => {
  const a = entry({ id: 1, mode: "until_next", playlistId: 10, startsAt: "2026-01-01T00:00:00Z" });
  const b = entry({ id: 2, mode: "until_next", playlistId: 20, startsAt: "2026-02-01T00:00:00Z" });

  assert.equal(resolveSchedule([a, b], at("2026-01-15T12:00:00Z"), CHI).entry?.id, 1);
  assert.equal(resolveSchedule([a, b], at("2026-02-15T12:00:00Z"), CHI).entry?.id, 2);
  // Before either has started, nothing is scheduled.
  assert.equal(resolveSchedule([a, b], at("2025-12-31T12:00:00Z"), CHI).entry, null);
});

test("a window borrows the screen from the standing content and hands it back", () => {
  const standing = entry({ id: 1, mode: "until_next", startsAt: "2026-01-01T00:00:00Z" });
  const special = entry({ id: 2, mode: "window", startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });

  assert.equal(resolveSchedule([standing, special], at("2026-01-15T09:00:00Z"), CHI).entry?.id, 1);
  assert.equal(resolveSchedule([standing, special], at("2026-01-15T10:30:00Z"), CHI).entry?.id, 2);
  assert.equal(resolveSchedule([standing, special], at("2026-01-15T11:30:00Z"), CHI).entry?.id, 1);
});

test("an open-ended entry has no end but still reports when the answer changes", () => {
  const standing = entry({ id: 1, mode: "until_next", startsAt: "2026-01-01T00:00:00Z" });
  const special = entry({ id: 2, mode: "window", startsAt: "2026-01-15T10:00:00Z", endsAt: "2026-01-15T11:00:00Z" });
  const r = resolveSchedule([standing, special], at("2026-01-14T00:00:00Z"), CHI);
  assert.equal(r.endsAt, null);
  assert.equal(r.changesAt?.toISOString(), "2026-01-15T10:00:00.000Z");
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

test("a window saved without an end is treated as open-ended rather than vanishing", () => {
  const e = entry({ id: 10, mode: "window", startsAt: "2026-01-15T10:00:00Z", endsAt: null });
  assert.equal(resolveSchedule([e], at("2026-01-16T10:30:00Z"), CHI).entry?.id, 10);
});

test("describeEntries marks the superseded open-ended entry", () => {
  const a = entry({ id: 1, mode: "until_next", startsAt: "2026-01-01T00:00:00Z" });
  const b = entry({ id: 2, mode: "until_next", startsAt: "2026-02-01T00:00:00Z" });
  const later = entry({ id: 3, mode: "window", startsAt: "2026-03-01T00:00:00Z", endsAt: "2026-03-02T00:00:00Z" });

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
  assert.equal(validateEntry({ mode: "until_next", playlistId: 1, startsAt: "2026-01-15T10:00:00Z" }).ok, true);
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
