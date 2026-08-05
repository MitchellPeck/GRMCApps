import { Pool } from "pg";
import { getSetting } from "./settings";
import { DEFAULT_TZ, isWeekday, suggestDate, todayInTimezone } from "./dates";

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
