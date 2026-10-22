import { addDays, daySpan, localDateKey, mergeSpans, parseHM, Span, weekdayOf } from "./tz";

export type ScheduleMode = "window" | "recurring";

export interface ScheduleEntry {
  id: number;
  playlistId: number;
  mode: ScheduleMode;
  label: string;
  /** window: the instant it starts. */
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
  /** Every entry covering the moment, best first. `entry` is the first. */
  candidates: ScheduleEntry[];
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

// The occurrence that starts on `dateKey`, as instants.
function occurrenceOn(
  entry: ScheduleEntry,
  dateKey: string,
  timeZone: string
): Candidate | null {
  if (!firesOn(entry, dateKey)) return null;
  const span = daySpan(dateKey, entry.startTime, entry.endTime, timeZone);
  return span ? { entry, start: span.start, end: span.end } : null;
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
  // A slot whose first date is weeks away would otherwise fall past the
  // horizon and read as finished before it has ever run.
  if (entry.effectiveFrom && entry.effectiveFrom > key) key = entry.effectiveFrom;
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
 * Every entry covering `now` (a `window`, or a `recurring` occurrence) is a
 * candidate. Higher priority wins, then the one that started most recently,
 * then the newest. There is no fallback: nothing covering `now` means nothing
 * plays and the TV is off.
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
    const start = parseInstant(entry.startsAt);
    const end = parseInstant(entry.endsAt);
    if (start && end && ms(start) <= ms(now) && ms(now) < ms(end)) {
      bounded.push({ entry, start, end });
    }
  }

  bounded.sort(
    (a, b) =>
      b.entry.priority - a.entry.priority ||
      ms(b.start) - ms(a.start) ||
      b.entry.id - a.entry.id
  );

  const winner: Candidate | null = bounded[0] ?? null;
  const candidates = bounded.map((c) => c.entry);
  const changesAt = nextBoundary(live, now, timeZone, winner ? winner.end : null);

  if (winner) {
    return { entry: winner.entry, candidates, startedAt: winner.start, endsAt: winner.end, changesAt };
  }
  return { entry: null, candidates, startedAt: null, endsAt: null, changesAt };
}

/**
 * Whether anything at all is scheduled at `now`, and when that next flips.
 * This, not the playlist's contents, is what turns the TV on and off.
 *
 * Occurrences of every entry are merged before looking, so two entries that
 * meet or overlap -- whatever they play -- are one stretch of being on.
 */
export function scheduleCoverage(
  entries: ScheduleEntry[],
  now: Date,
  timeZone: string
): { on: boolean; changesAt: Date | null } {
  const spans: Span[] = [];
  for (const entry of entries) {
    if (!entry.enabled) continue;
    if (entry.mode === "recurring") {
      // From yesterday: an overnight occurrence that began before midnight
      // is still the one covering 00:30.
      let key = addDays(localDateKey(now, timeZone), -1);
      for (let i = 0; i <= HORIZON_DAYS + 1; i++) {
        const occ = occurrenceOn(entry, key, timeZone);
        if (occ) spans.push({ start: occ.start, end: occ.end });
        key = addDays(key, 1);
      }
      continue;
    }
    const start = parseInstant(entry.startsAt);
    const end = parseInstant(entry.endsAt);
    if (start && end && ms(end) > ms(start)) spans.push({ start, end });
  }

  const merged = mergeSpans(spans);
  for (const span of merged) {
    if (ms(span.start) <= ms(now) && ms(now) < ms(span.end)) {
      return { on: true, changesAt: span.end };
    }
  }
  const next = merged.find((span) => ms(span.start) > ms(now));
  return { on: false, changesAt: next ? next.start : null };
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
  if (mode !== "window" && mode !== "recurring") {
    return { ok: false, error: "Pick how this should be scheduled." };
  }
  if (!entry.playlistId) return { ok: false, error: "Pick a playlist to play." };

  if (mode === "window") {
    const start = parseInstant(entry.startsAt ?? null);
    if (!start) return { ok: false, error: "Give this a start date and time." };
    const end = parseInstant(entry.endsAt ?? null);
    if (!end) return { ok: false, error: "Give this an end date and time." };
    if (ms(end) <= ms(start)) {
      return { ok: false, error: "The end has to come after the start." };
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
 * Per-entry state for the schedule list. `superseded` is a window that is
 * running but another entry currently has the screen.
 */
export function describeEntries(
  entries: ScheduleEntry[],
  now: Date,
  timeZone: string
): EntryStatus[] {
  const winner = resolveSchedule(entries, now, timeZone);

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
    if (!end || ms(now) >= ms(end)) {
      return { id: entry.id, state: "finished" as EntryState, nextStart: null, currentEnd: null };
    }
    return {
      id: entry.id,
      state: winner.entry?.id === entry.id ? "active" : "superseded",
      nextStart: null,
      currentEnd: end,
    };
  });
}
