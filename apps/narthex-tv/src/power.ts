import { Span, addDays, daySpan, localDateKey, weekdayOf } from "./tz";

/** One "the screen is awake" window on one weekday, in the app's timezone. */
export interface HoursWindow {
  id: number;
  day: number;          // 0 = Sunday .. 6 = Saturday
  startTime: string;    // 'HH:MM'
  endTime: string;
  enabled: boolean;
}

export type HoursMode = "always" | "scheduled";

export interface PowerState {
  /** Should there be a picture at all right now? */
  on: boolean;
  /** When that answer next flips. null = never (always-on, or nothing set). */
  changesAt: Date | null;
}

const ms = (d: Date) => d.getTime();

// How far ahead to look for the next wake-up. A week plus a day covers every
// weekly pattern, including one that only fires on the day we started from.
const HORIZON_DAYS = 8;

/**
 * Every awake-window instant in a range around `now`, merged.
 *
 * Merging matters: two windows that touch or overlap (09:00-12:00 and
 * 11:00-17:00, or a Saturday-night window running into Sunday) are one
 * stretch of being awake, and the screen must not blink off between them.
 */
export function mergedSpans(
  windows: HoursWindow[],
  now: Date,
  timeZone: string
): Span[] {
  const live = windows.filter((w) => w.enabled);
  if (!live.length) return [];

  const spans: Span[] = [];
  // Start a day early: an overnight window that began yesterday is still the
  // one we are inside at 00:30.
  let key = addDays(localDateKey(now, timeZone), -1);
  for (let i = 0; i <= HORIZON_DAYS + 1; i++) {
    const weekday = weekdayOf(key);
    for (const w of live) {
      if (w.day !== weekday) continue;
      const span = daySpan(key, w.startTime, w.endTime, timeZone);
      if (span) spans.push(span);
    }
    key = addDays(key, 1);
  }

  spans.sort((a, b) => ms(a.start) - ms(b.start));
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && ms(span.start) <= ms(last.end)) {
      if (ms(span.end) > ms(last.end)) last.end = span.end;
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }
  return merged;
}

/**
 * Whether the narthex screen should be showing anything at `now`.
 *
 * An EMPTY grid keeps the screen on. That is deliberate: no rows at all means
 * nobody has set this up yet, and a narthex that went dark because of an
 * unconfigured feature is the worse failure.
 *
 * Rows that exist are obeyed, including when every one of them is switched
 * off — those rows are a decision somebody made, and silently overriding them
 * would be worse than honouring them. That case does leave the screen dark
 * indefinitely, so the admin screen calls it out rather than leaving it to be
 * discovered on a Sunday morning.
 */
export function resolvePower(
  mode: HoursMode,
  windows: HoursWindow[],
  now: Date,
  timeZone: string
): PowerState {
  if (mode !== "scheduled") return { on: true, changesAt: null };
  if (!windows.length) return { on: true, changesAt: null };

  const merged = mergedSpans(windows, now, timeZone);
  for (const span of merged) {
    if (ms(span.start) <= ms(now) && ms(now) < ms(span.end)) {
      return { on: true, changesAt: span.end };
    }
  }
  const next = merged.find((s) => ms(s.start) > ms(now));
  return { on: false, changesAt: next ? next.start : null };
}

export type HoursValidation = { ok: true } | { ok: false; error: string };

export function validateWindow(w: Partial<HoursWindow>): HoursValidation {
  if (!Number.isInteger(w.day) || (w.day as number) < 0 || (w.day as number) > 6) {
    return { ok: false, error: "Pick a day of the week." };
  }
  if (!daySpan("2026-01-04", w.startTime ?? "", w.endTime ?? "", "UTC")) {
    return { ok: false, error: "Give this a start and end time, like 07:30 and 21:00." };
  }
  return { ok: true };
}

/** A sensible starting grid: awake through the working day, every day. */
export const DEFAULT_WINDOWS: Array<Omit<HoursWindow, "id">> = [
  { day: 0, startTime: "07:30", endTime: "13:00", enabled: true }, // Sunday
  { day: 1, startTime: "08:00", endTime: "17:00", enabled: true },
  { day: 2, startTime: "08:00", endTime: "17:00", enabled: true },
  { day: 3, startTime: "08:00", endTime: "17:00", enabled: true },
  { day: 4, startTime: "08:00", endTime: "17:00", enabled: true },
  { day: 5, startTime: "08:00", endTime: "17:00", enabled: true },
  { day: 6, startTime: "08:00", endTime: "12:00", enabled: true },
];
