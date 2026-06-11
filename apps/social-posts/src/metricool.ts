import { Pool } from "pg";
import { getSetting } from "./settings";

export interface PayloadInput {
  text: string;
  networks: string[];
  dateTime: string;
  timezone: string;
  mediaUrl: string;
}
export interface SchedulerPayload {
  publicationDate: { dateTime: string; timezone: string };
  text: string;
  providers: Array<{ network: string }>;
  autoPublish: boolean;
  facebookData?: { type: string };
  media?: string[];
}

export function buildSchedulerPayload(i: PayloadInput): SchedulerPayload {
  const payload: SchedulerPayload = {
    publicationDate: { dateTime: i.dateTime, timezone: i.timezone },
    text: i.text,
    providers: i.networks.map((n) => ({ network: n })),
    autoPublish: false,
  };
  if (i.networks.includes("facebook")) payload.facebookData = { type: "POST" };
  if (i.mediaUrl) payload.media = [i.mediaUrl];
  return payload;
}

const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const MONTHS: Record<string, number> = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

export type DateSource =
  | { kind: "weekday"; weekday: string }
  | { kind: "seriesDate"; label: string };

export function suggestDateTime(src: DateSource, def: { refDate: string; time: string }): string {
  const [y, m, d] = def.refDate.split("-").map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12));
  let target: Date;
  if (src.kind === "weekday") {
    const want = WEEKDAYS.indexOf(src.weekday.toLowerCase());
    const cur = ref.getUTCDay();
    let delta = (want - cur + 7) % 7;
    if (delta === 0) delta = 7;
    target = new Date(ref.getTime() + delta * 86400000);
  } else {
    const [mon, day] = src.label.split(" ");
    target = new Date(Date.UTC(ref.getUTCFullYear(), MONTHS[mon] ?? 0, parseInt(day, 10), 12));
  }
  const yyyy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(target.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${def.time}:00`;
}

const LIMITS: Record<string, number> = { instagram: 2200, facebook: 16192, twitter: 280, google: 1500 };
export function charWarnings(text: string, networks: string[]): string[] {
  const out: string[] = [];
  for (const n of networks) {
    const lim = LIMITS[n];
    if (lim && text.length > lim) out.push(`${n} limit is ${lim} chars; this post is ${text.length}.`);
  }
  return out;
}

export interface MetricoolCreds { token: string; userId: string; blogId: string; }

export async function getMetricoolCreds(pool: Pool): Promise<MetricoolCreds> {
  const token = await getSetting(pool, "metricool_token");
  const userId = await getSetting(pool, "metricool_user_id");
  const blogId = await getSetting(pool, "metricool_blog_id");
  if (!token || !userId) throw new Error("Metricool not configured — add your token in Settings.");
  return { token, userId, blogId };
}

const BASE = "https://app.metricool.com/api";

function mcHeaders(c: MetricoolCreds): Record<string, string> {
  return { "X-Mc-Auth": c.token, "content-type": "application/json" };
}

// List the brands the token can access so the user can pick a blogId.
// NOTE: confirm the exact brands path against the live API/CLI during build;
// adjust the path/field mapping here if it differs.
export async function listBrands(c: MetricoolCreds): Promise<Array<{ id: string; label: string }>> {
  const res = await fetch(`${BASE}/admin/simpleProfiles?userId=${encodeURIComponent(c.userId)}`, { headers: mcHeaders(c) });
  const data: any = await res.json();
  const arr: any[] = Array.isArray(data) ? data : data.profiles || data.brands || [];
  return arr.map((b) => ({ id: String(b.blogId ?? b.id), label: String(b.label ?? b.title ?? b.brand ?? b.blogId ?? b.id) }));
}

// Normalize a PUBLIC media url so Metricool hosts it; returns the usable url.
// Endpoint confirmed against Metricool's API (GET /actions/normalize/image/url).
// The response is the normalized URL — either a JSON-quoted string or plain text.
export async function normalizeMedia(c: MetricoolCreds, publicUrl: string): Promise<string> {
  const url = `${BASE}/actions/normalize/image/url?url=${encodeURIComponent(publicUrl)}&userId=${encodeURIComponent(c.userId)}${c.blogId ? `&blogId=${encodeURIComponent(c.blogId)}` : ""}`;
  const res = await fetch(url, { headers: mcHeaders(c) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Metricool media normalize failed (${res.status})`);
  try {
    const data: any = JSON.parse(text);
    return typeof data === "string" ? data : String(data.url ?? data.media ?? publicUrl);
  } catch {
    return text.trim();
  }
}

export async function schedulePost(c: MetricoolCreds, payload: SchedulerPayload): Promise<string> {
  const url = `${BASE}/v2/scheduler/posts?userId=${encodeURIComponent(c.userId)}&blogId=${encodeURIComponent(c.blogId)}`;
  const res = await fetch(url, { method: "POST", headers: mcHeaders(c), body: JSON.stringify(payload) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `Metricool scheduler failed (${res.status})`);
  return String(data.id ?? data.postId ?? "");
}
