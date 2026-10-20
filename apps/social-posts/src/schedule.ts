import { Pool } from "pg";
import { getSetting } from "./settings";
import { DEFAULT_TZ, todayInTimezone } from "./dates";

// The reference "today" for every scheduling suggestion: the church's local
// date, not the container's UTC date.
export async function referenceDate(pool: Pool): Promise<string> {
  const tz = (await getSetting(pool, "default_timezone")) || DEFAULT_TZ;
  return todayInTimezone(tz);
}
