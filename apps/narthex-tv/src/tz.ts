// Timezone arithmetic without a dependency. The recurring schedule is written
// in wall-clock time ("Sundays 8:00–12:30"), so turning that into an instant
// needs the offset that was in effect on that date — not the one in effect now.
// Node ships full ICU, so Intl is the source of truth for both directions.

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = cache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    cache.set(timeZone, f);
  }
  return f;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

// How far ahead of UTC the zone is at this instant, in milliseconds.
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Wall-clock time in `timeZone` -> the instant it names. Guess with the offset
// at the same numeric UTC time, then correct once: that settles every case
// except the hour that does not exist on a spring-forward day, which lands on
// the instant the clock jumps to.
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const guess = new Date(target - tzOffsetMs(new Date(target), timeZone));
  const corrected = target - tzOffsetMs(guess, timeZone);
  return new Date(corrected);
}

// 'YYYY-MM-DD' for the local calendar date this instant falls on.
export function localDateKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(
    p.day
  ).padStart(2, "0")}`;
}

export function parseDateKey(key: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function addDays(key: string, n: number): string {
  const d = parseDateKey(key);
  if (!d) return key;
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  t.setUTCDate(t.getUTCDate() + n);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(
    t.getUTCDate()
  ).padStart(2, "0")}`;
}

// 0 = Sunday. Derived from the calendar date itself, so it is independent of
// any zone: a date's weekday is the same everywhere.
export function weekdayOf(key: string): number {
  const d = parseDateKey(key);
  if (!d) return 0;
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

// 'HH:MM' -> minutes since local midnight.
export function parseHM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

export interface Span {
  start: Date;
  end: Date;
}

/**
 * A wall-clock time range anchored to one local calendar day, as instants.
 *
 * `end <= start` means the range runs past midnight (22:00-02:00), and
 * `end === start` means a full 24 hours. Both the recurring schedule and the
 * operating-hours grid are the same shape, so both go through here.
 */
export function daySpan(
  dateKey: string,
  startTime: string,
  endTime: string,
  timeZone: string
): Span | null {
  const startMin = parseHM(startTime);
  const endMin = parseHM(endTime);
  if (startMin === null || endMin === null) return null;

  const from = parseDateKey(dateKey);
  if (!from) return null;
  const endKey = endMin <= startMin ? addDays(dateKey, 1) : dateKey;
  const to = parseDateKey(endKey);
  if (!to) return null;

  return {
    start: zonedTimeToUtc(from.year, from.month, from.day, Math.floor(startMin / 60), startMin % 60, timeZone),
    end: zonedTimeToUtc(to.year, to.month, to.day, Math.floor(endMin / 60), endMin % 60, timeZone),
  };
}
