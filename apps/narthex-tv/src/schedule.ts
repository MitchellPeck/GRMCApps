import { addDays, localDateKey, parseDateKey, parseHM, weekdayOf, zonedTimeToUtc } from "./tz";

export type ScheduleMode = "window" | "until_next" | "recurring";

export interface ScheduleEntry {
  id: number;
  playlistId: number;
  mode: ScheduleMode;
  label: string;
  /** window + until_next: the instant it starts. */
  startsAt: string | null;
  /** window: the instant it stops. */
  endsAt: string | null;
  /** recurring: 0 = Sunday .. 6 = Saturday. Empty means every day. */
  days: number[];
  /** recurring: 'HH:MM' local wall-clock. */
  startTime: string;
  endTime: string;
  /** recurring: optional 'YYYY-MM-DD' bounds on which dates may fire. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  priority: number;
  enabled: boolean;
}

export interface Resolution {
  entry: ScheduleEntry | null;
  /** When the winning entry began. */
  startedAt: Date | null;
  /** When it stops on its own. null = it runs until something displaces it. */
  endsAt: Date | null;
  /** The next instant the answer could differ — what the UI counts down to. */
  changesAt: Date | null;
}

interface Candidate {
  entry: ScheduleEntry;
  start: Date;
  end: Date;
}

const ms = (d: Date) => d.getTime();
const parseInstant = (iso: string | null): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};

function withinEffective(entry: ScheduleEntry, dateKey: string): boolean {
  if (entry.effectiveFrom && dateKey < entry.effectiveFrom) return false;
  if (entry.effectiveTo && dateKey > entry.effectiveTo) return false;
  return true;
}

function firesOn(entry: ScheduleEntry, dateKey: string): boolean {
  if (!withinEffective(entry, dateKey)) return false;
  if (!entry.days || entry.days.length === 0) return true; // every day
  return entry.days.includes(weekdayOf(dateKey));
}

// The occurrence that starts on `dateKey`, as instants. `end <= start` means the
// window runs past midnight (22:00–02:00), and end === start means a full day.
function occurrenceOn(
  entry: ScheduleEntry,
  dateKey: string,
  timeZone: string
): Candidate | null {
  const startMin = parseHM(entry.startTime);
  const endMin = parseHM(entry.endTime);
  if (startMin === null || endMin === null) return null;
  if (!firesOn(entry, dateKey)) return null;

  const d = parseDateKey(dateKey);
  if (!d) return null;

  const start = zonedTimeToUtc(d.year, d.month, d.day, Math.floor(startMin / 60), startMin % 60, timeZone);
  const endKey = endMin <= startMin ? addDays(dateKey, 1) : dateKey;
  const e = parseDateKey(endKey)!;
  const end = zonedTimeToUtc(e.year, e.month, e.day, Math.floor(endMin / 60), endMin % 60, timeZone);
  return { entry, start, end };
}

/** The recurring occurrence covering `now`, if any. */
export function recurringOccurrenceAt(
  entry: ScheduleEntry,
  now: Date,
  timeZone: string
): Candidate | null {
  const today = localDateKey(now, timeZone);
  // Yesterday too: an overnight window that began before local midnight is
  // still the one playing at 00:30.
  for (const key of [today, addDays(today, -1)]) {
    const occ = occurrenceOn(entry, key, timeZone);
    if (occ && ms(occ.start) <= ms(now) && ms(now) < ms(occ.end)) return occ;
  }
  return null;
}

const HORIZON_DAYS = 8;

/** The first occurrence of a recurring entry that starts after `now`. */
export function nextRecurringStart(
  entry: ScheduleEntry,
  now: Date,
  timeZone: string
): Date | null {
  let key = localDateKey(now, timeZone);
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const occ = occurrenceOn(entry, key, timeZone);
    if (occ && ms(occ.start) > ms(now)) return occ.start;
    key = addDays(key, 1);
  }
  return null;
}

/**
 * What should be on the screen at `now`.
 *
 * Precedence, highest first:
 *   1. Bounded entries covering `now` — a `window` or a `recurring` occurrence.
 *      Among those: higher priority, then the one that started most recently,
 *      then the newest. A bounded entry is a deliberate "this, at this time",
 *      so it displaces the standing content and hands it back when it ends.
 *   2. The most recently started `until_next` entry. This is the "plays until
 *      something else is scheduled after it" mode: a later one supersedes it
 *      permanently, a bounded one only borrows the screen.
 *   3. Nothing — the caller falls back to the default playlist.
 */
export function resolveSchedule(
  entries: ScheduleEntry[],
  now: Date,
  timeZone: string
): Resolution {
  const live = entries.filter((e) => e.enabled);
  const bounded: Candidate[] = [];

  for (const entry of live) {
    if (entry.mode === "recurring") {
      const occ = recurringOccurrenceAt(entry, now, timeZone);
      if (occ) bounded.push(occ);
      continue;
    }
    if (entry.mode === "window") {
      const start = parseInstant(entry.startsAt);
      const end = parseInstant(entry.endsAt);
      // A window saved without an end would otherwise be invisible forever;
      // treat it as the open-ended mode it clearly meant.
      if (start && end && ms(start) <= ms(now) && ms(now) < ms(end)) {
        bounded.push({ entry, start, end });
      }
    }
  }

  bounded.sort(
    (a, b) =>
      b.entry.priority - a.entry.priority ||
      ms(b.start) - ms(a.start) ||
      b.entry.id - a.entry.id
  );

  let winner: Candidate | null = bounded[0] ?? null;
  let openEnded: { entry: ScheduleEntry; start: Date } | null = null;

  if (!winner) {
    for (const entry of live) {
      if (entry.mode !== "until_next" && !(entry.mode === "window" && !entry.endsAt)) continue;
      const start = parseInstant(entry.startsAt);
      if (!start || ms(start) > ms(now)) continue;
      if (
        !openEnded ||
        ms(start) > ms(openEnded.start) ||
        (ms(start) === ms(openEnded.start) && entry.id > openEnded.entry.id)
      ) {
        openEnded = { entry, start };
      }
    }
  }

  const changesAt = nextBoundary(live, now, timeZone, winner ? winner.end : null);

  if (winner) {
    return { entry: winner.entry, startedAt: winner.start, endsAt: winner.end, changesAt };
  }
  if (openEnded) {
    return { entry: openEnded.entry, startedAt: openEnded.start, endsAt: null, changesAt };
  }
  return { entry: null, startedAt: null, endsAt: null, changesAt };
}

// The earliest of: the winner's own end, and every entry's next start. An
// over-approximation is safe — the worst case is the player re-reads a plan
// that turns out to be identical.
function nextBoundary(
  live: ScheduleEntry[],
  now: Date,
  timeZone: string,
  winnerEnd: Date | null
): Date | null {
  let best: Date | null = winnerEnd && ms(winnerEnd) > ms(now) ? winnerEnd : null;
  const consider = (d: Date | null) => {
    if (!d || ms(d) <= ms(now)) return;
    if (!best || ms(d) < ms(best)) best = d;
  };

  for (const entry of live) {
    if (entry.mode === "recurring") {
      consider(nextRecurringStart(entry, now, timeZone));
      continue;
    }
    consider(parseInstant(entry.startsAt));
    if (entry.mode === "window") consider(parseInstant(entry.endsAt));
  }
  return best;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects an entry that could never play, before it is stored. */
export function validateEntry(entry: Partial<ScheduleEntry>): ValidationResult {
  const mode = entry.mode;
  if (mode !== "window" && mode !== "until_next" && mode !== "recurring") {
    return { ok: false, error: "Pick how this should be scheduled." };
  }
  if (!entry.playlistId) return { ok: false, error: "Pick a playlist to play." };

  if (mode === "window" || mode === "until_next") {
    const start = parseInstant(entry.startsAt ?? null);
    if (!start) return { ok: false, error: "Give this a start date and time." };
    if (mode === "window") {
      const end = parseInstant(entry.endsAt ?? null);
      if (!end) return { ok: false, error: "Give this an end date and time." };
      if (ms(end) <= ms(start)) {
        return { ok: false, error: "The end has to come after the start." };
      }
    }
    return { ok: true };
  }

  if (parseHM(entry.startTime ?? "") === null) {
    return { ok: false, error: "Give this a start time, like 08:00." };
  }
  if (parseHM(entry.endTime ?? "") === null) {
    return { ok: false, error: "Give this an end time, like 12:30." };
  }
  for (const d of entry.days ?? []) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      return { ok: false, error: "Days of the week are Sunday through Saturday." };
    }
  }
  for (const [label, key] of [
    ["from", entry.effectiveFrom],
    ["to", entry.effectiveTo],
  ] as const) {
    if (key && !DATE_KEY.test(key)) {
      return { ok: false, error: `The "${label}" date isn't a valid date.` };
    }
  }
  if (entry.effectiveFrom && entry.effectiveTo && entry.effectiveTo < entry.effectiveFrom) {
    return { ok: false, error: "The repeat window ends before it starts." };
  }
  return { ok: true };
}

export type EntryState = "active" | "upcoming" | "superseded" | "finished" | "disabled";

export interface EntryStatus {
  id: number;
  state: EntryState;
  /** When it next begins (recurring entries included). */
  nextStart: Date | null;
  /** When the current airing stops, if it is on now and bounded. */
  currentEnd: Date | null;
}

/**
 * Per-entry state for the schedule list. `superseded` is specific to the
 * open-ended mode: the entry has started and never ends, but a later one took
 * the screen for good, so it will not come back.
 */
export function describeEntries(
  entries: ScheduleEntry[],
  now: Date,
  timeZone: string
): EntryStatus[] {
  const winner = resolveSchedule(entries, now, timeZone);
  const latestOpen = entries
    .filter((e) => e.enabled && e.mode === "until_next" && e.startsAt)
    .map((e) => ({ e, start: parseInstant(e.startsAt) }))
    .filter((x): x is { e: ScheduleEntry; start: Date } => x.start !== null && ms(x.start) <= ms(now))
    .sort((a, b) => ms(b.start) - ms(a.start) || b.e.id - a.e.id)[0];

  return entries.map((entry) => {
    if (!entry.enabled) {
      return { id: entry.id, state: "disabled" as EntryState, nextStart: null, currentEnd: null };
    }
    if (entry.mode === "recurring") {
      const occ = recurringOccurrenceAt(entry, now, timeZone);
      const next = nextRecurringStart(entry, now, timeZone);
      return {
        id: entry.id,
        state: occ ? "active" : next ? "upcoming" : "finished",
        nextStart: next,
        currentEnd: occ ? occ.end : null,
      };
    }
    const start = parseInstant(entry.startsAt);
    const end = parseInstant(entry.endsAt);
    if (!start) {
      return { id: entry.id, state: "finished" as EntryState, nextStart: null, currentEnd: null };
    }
    if (ms(start) > ms(now)) {
      return { id: entry.id, state: "upcoming" as EntryState, nextStart: start, currentEnd: null };
    }
    if (entry.mode === "window") {
      if (end && ms(now) >= ms(end)) {
        return { id: entry.id, state: "finished" as EntryState, nextStart: null, currentEnd: null };
      }
      return {
        id: entry.id,
        state: winner.entry?.id === entry.id ? "active" : "superseded",
        nextStart: null,
        currentEnd: end,
      };
    }
    // until_next
    const isLatest = latestOpen?.e.id === entry.id;
    return {
      id: entry.id,
      state: isLatest ? (winner.entry?.id === entry.id ? "active" : "superseded") : "superseded",
      nextStart: null,
      currentEnd: null,
    };
  });
}
