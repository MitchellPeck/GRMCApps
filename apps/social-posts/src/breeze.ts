import { Pool } from "pg";
import { getSetting } from "./settings";
import type { FetchFn } from "./gracenotes/mail";

export interface BreezeConfig { subdomain: string; apiKey: string }
export interface BreezeCalendar { id: string; name: string }
export interface BreezeInstance {
  instanceId: string; seriesId: string; name: string; calendarId: string;
  /** Local calendar date, YYYY-MM-DD, taken straight from Breeze's text. */
  date: string;
  startRaw: string;
}

// The subdomain becomes a hostname, so anything else could send the key elsewhere.
export function cleanSubdomain(raw: string): string | null {
  const v = (raw || "").trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(v) ? v : null;
}

export async function loadBreezeConfig(pool: Pool): Promise<BreezeConfig | null> {
  const subdomain = cleanSubdomain(await getSetting(pool, "breeze_subdomain"));
  const apiKey = (await getSetting(pool, "breeze_api_key")).trim();
  return subdomain && apiKey ? { subdomain, apiKey } : null;
}

export async function tickedCalendars(pool: Pool): Promise<string[]> {
  try {
    const v = JSON.parse((await getSetting(pool, "breeze_calendars")) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Errors name the status only: the key must never reach a log or the page.
async function get(cfg: BreezeConfig, path: string, fetchFn: FetchFn): Promise<any> {
  const res = await fetchFn(`https://${cfg.subdomain}.breezechms.com${path}`, {
    headers: { "Api-Key": cfg.apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status !== 200) throw new Error(`Breeze returned ${res.status}`);
  return res.json();
}

export async function listCalendars(cfg: BreezeConfig, fetchFn: FetchFn = fetch): Promise<BreezeCalendar[]> {
  const rows = await get(cfg, "/api/events/calendars/list", fetchFn);
  // Breeze can answer 200 with an error object; that must not read as "no calendars".
  if (!Array.isArray(rows)) throw new Error("Breeze returned an unexpected reply");
  return rows.map((r: any) => ({ id: String(r.id), name: String(r.name ?? "") }));
}

// Breeze sends local wall-clock text with no zone, so the date is sliced, not parsed.
export function parseInstance(raw: any): BreezeInstance {
  const startRaw = String(raw.start_datetime ?? "");
  return {
    instanceId: String(raw.id),
    seriesId: String(raw.event_id),
    name: String(raw.name ?? ""),
    calendarId: String(raw.category_id),
    date: startRaw.slice(0, 10),
    startRaw,
  };
}

export async function listInstances(
  cfg: BreezeConfig, calendarId: string, from: string, to: string, fetchFn: FetchFn = fetch
): Promise<BreezeInstance[]> {
  const q = new URLSearchParams({ start: from, end: to, category_id: calendarId, limit: "500" });
  const rows = await get(cfg, `/api/events?${q}`, fetchFn);
  if (!Array.isArray(rows)) throw new Error("Breeze returned an unexpected reply");
  // Hitting the limit means the reply may be cut off, which would look like removals.
  if (rows.length >= 500)
    throw new Error("Breeze calendar has too many events in this window to read safely");
  return rows.map(parseInstance).filter((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.date));
}
