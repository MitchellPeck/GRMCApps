// Metricool's planner list, read into one typed shape that sync reconciles
// against. PROVISIONAL — replace with real probe output: the fixtures this was
// written against are invented, so which case Metricool really uses when one
// network of a multi-network post is moved (a: that network reappears under a
// new post id; b: the same post id carries a different time per network) is
// not recorded yet. parsePlanner handles both, since it reads per network.
import { createHash } from "node:crypto";
import { fetchSchedulerPostsRaw, MetricoolCreds } from "./metricool";

export type LinkState = "draft" | "scheduled" | "published" | "failed" | "gone";
export interface PlannerNetwork {
  network: "facebook" | "instagram" | "x";
  scheduledFor: string; // YYYY-MM-DDTHH:MM in the church's zone
  state: LinkState | "unknown";
  detail: string;
  publicUrl: string;
  text: string;
}
export interface PlannerPost { id: string; networks: PlannerNetwork[]; media: string[] }

const UNREADABLE = "Metricool's planner list wasn't readable.";

export function mapState(status: string, publicUrl: string, autoPublish: boolean): LinkState | "unknown" {
  if (publicUrl || /^PUBLISHED$/i.test(status || "")) return "published";
  if (/ERROR|FAIL|REJECT/i.test(status || "")) return "failed";
  if (!autoPublish) return "draft";
  if (/PENDING|SCHEDULED|QUEUED|PROCESSING/i.test(status || "")) return "scheduled";
  return "unknown";
}

export function textHash(text: string): string {
  return createHash("sha1").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
}

function networkOf(raw: unknown): PlannerNetwork["network"] | null {
  const n = String(raw || "").toLowerCase();
  if (n === "facebook" || n === "instagram") return n;
  if (n === "twitter" || n === "x") return "x";
  return null;
}

// "YYYY-MM-DDTHH:MM" for an instant, as the wall clock reads in `tz`.
function wallIn(tz: string, instant: Date): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(instant)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// The instant at which `zone`'s wall clock reads `wall` (given as if UTC).
function instantOfWall(wall: Date, zone: string): Date {
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const seen = new Date(wallIn(zone, guess) + "Z");
    guess = new Date(guess.getTime() + (wall.getTime() - seen.getTime()));
  }
  return guess;
}

// A dateTime ending in Z or carrying an offset is an instant. Otherwise it's a
// wall time in the row's own zone (the church's, if the row names none).
function scheduledFor(pd: any, tz: string): string {
  const raw = String(pd?.dateTime || "");
  if (!raw) return "";
  try {
    if (/(Z|[+-]\d\d:?\d\d)$/i.test(raw)) return wallIn(tz, new Date(raw));
    const zone = String(pd?.timezone || tz);
    const wall = new Date(raw.slice(0, 16) + ":00Z");
    if (isNaN(wall.getTime())) return "";
    return zone === tz ? raw.slice(0, 16) : wallIn(tz, instantOfWall(wall, zone));
  } catch {
    return "";
  }
}

export function parsePlanner(body: unknown, timezone: string): PlannerPost[] {
  const rows: any[] | null = Array.isArray(body) ? body : Array.isArray((body as any)?.data) ? (body as any).data : null;
  if (!rows) throw new Error(UNREADABLE);
  return rows.map((row) => {
    const when = scheduledFor(row?.publicationDate, timezone);
    const autoPublish = row?.autoPublish !== false;
    const networks: PlannerNetwork[] = [];
    for (const p of Array.isArray(row?.providers) ? row.providers : []) {
      const network = networkOf(p?.network);
      if (!network) continue;
      const publicUrl = String(p.publicUrl || "");
      networks.push({
        network,
        scheduledFor: when,
        state: mapState(String(p.status || ""), publicUrl, autoPublish),
        detail: String(p.detailedStatus || p.status || ""),
        publicUrl,
        text: String(p.text ?? row?.text ?? ""),
      });
    }
    const media = Array.isArray(row?.media) ? row.media.map((m: any) => String(typeof m === "string" ? m : m?.url || "")).filter(Boolean) : [];
    return { id: String(row?.id ?? ""), networks, media };
  });
}

export async function listPlanner(c: MetricoolCreds, start: string, end: string, timezone: string): Promise<PlannerPost[]> {
  const text = await fetchSchedulerPostsRaw(c, start, end, timezone);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error(UNREADABLE); }
  return parsePlanner(body, timezone);
}
