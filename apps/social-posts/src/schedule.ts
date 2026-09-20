import { Pool } from "pg";
import { getSetting } from "./settings";
import { DEFAULT_TZ, addDays, isWeekday, suggestDate, todayInTimezone } from "./dates";

// The reference "today" for every scheduling suggestion: the church's local
// date, not the container's UTC date.
export async function referenceDate(pool: Pool): Promise<string> {
  const tz = (await getSetting(pool, "default_timezone")) || DEFAULT_TZ;
  return todayInTimezone(tz);
}

// Map post keys ("wednesday", "saturday", ...) to the date that weekday falls
// on in the current week, so the Metricool date box prefills correctly.
export async function scheduleDatesFor(pool: Pool, keys: string[]): Promise<Record<string, string>> {
  const ref = await referenceDate(pool);
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (isWeekday(key)) out[key] = suggestDate({ kind: "weekday", weekday: key }, ref);
  }
  return out;
}

// Podcast angles are dated from the episode itself, so an episode that drops
// three weeks out gets posts three weeks out rather than this Wednesday.
export function podcastScheduleDates(
  angles: { key: string; offsetDays: number }[],
  publishDate: string
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!publishDate) return out;
  for (const a of angles) {
    const date = addDays(publishDate, a.offsetDays);
    if (date) out[a.key] = date;
  }
  return out;
}
