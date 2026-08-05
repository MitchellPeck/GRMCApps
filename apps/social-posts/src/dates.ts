// Date helpers shared by the Mailchimp preview, the drafts list and the
// Metricool scheduler. Everything here is pure so it can be unit tested; the
// only ambient input is `now`, which callers pass explicitly where it matters.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const DEFAULT_TZ = "America/New_York";

function isoOf(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function noonUTC(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

// "Today" as the church experiences it, not as the container's UTC clock does.
// en-CA formats as YYYY-MM-DD, which is exactly the shape the rest of this
// module (and every <input type="date">) expects.
export function todayInTimezone(tz: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return isoOf(now);
  }
}

export type DateSource =
  | { kind: "weekday"; weekday: string }
  | { kind: "seriesDate"; label: string };

// A weekday resolves to that day inside refDate's OWN week (Sunday-start), so a
// post labelled "Wednesday" drafted on Monday schedules for this Wednesday
// rather than skipping ahead seven days. A series label ("Aug 5") resolves to
// that calendar date in refDate's year.
export function suggestDate(src: DateSource, refDate: string): string {
  if (!refDate) return "";
  const ref = noonUTC(refDate);
  if (src.kind === "weekday") {
    const want = WEEKDAYS.indexOf((src.weekday || "").toLowerCase());
    if (want === -1) return "";
    return isoOf(new Date(ref.getTime() + (want - ref.getUTCDay()) * 86400000));
  }
  const [mon, day] = (src.label || "").split(" ");
  if (!(mon in MONTHS) || !day) return "";
  return isoOf(new Date(Date.UTC(ref.getUTCFullYear(), MONTHS[mon], parseInt(day, 10), 12)));
}

export function suggestDateTime(src: DateSource, def: { refDate: string; time: string }): string {
  const date = suggestDate(src, def.refDate);
  return date ? `${date}T${def.time}:00` : "";
}

export function isWeekday(key: string): boolean {
  return WEEKDAYS.indexOf((key || "").toLowerCase()) !== -1;
}

// Format either a full timestamp ("2026-07-31T14:02:00+00:00") or a bare
// calendar date ("2026-08-05"). Bare dates are formatted from their own parts —
// running them through a timezone would shift them a day backwards.
export function formatMonthDayYear(value: string, tz: string = DEFAULT_TZ): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz || DEFAULT_TZ, month: "short", day: "numeric", year: "numeric" }).format(d);
  } catch {
    return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }
}
