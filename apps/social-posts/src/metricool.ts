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
  draft: boolean;
  facebookData?: { type: string };
  media?: string[];
}

export function buildSchedulerPayload(i: PayloadInput): SchedulerPayload {
  // Metricool publishes a post only when autoPublish is true; autoPublish:false
  // is its "draft awaiting approval" state, and `draft` has to agree with it or
  // the post sits in the planner forever. Instagram can't be published by hand
  // from Metricool, so picking it turns publishing on for the whole post —
  // anything else it's grouped with goes out automatically too.
  const autoPublish = i.networks.includes("instagram");
  const payload: SchedulerPayload = {
    publicationDate: { dateTime: i.dateTime, timezone: i.timezone },
    text: i.text,
    providers: i.networks.map((n) => ({ network: n })),
    autoPublish,
    draft: !autoPublish,
  };
  if (i.networks.includes("facebook")) payload.facebookData = { type: "POST" };
  if (i.mediaUrl) payload.media = [i.mediaUrl];
  return payload;
}

const LIMITS: Record<string, number> = { instagram: 2200, facebook: 16192, twitter: 280, google: 1500 };
// Metricool still identifies X by its old provider id.
const NETWORK_LABELS: Record<string, string> = { twitter: "X" };
export function charWarnings(text: string, networks: string[]): string[] {
  const out: string[] = [];
  for (const n of networks) {
    const lim = LIMITS[n];
    if (lim && text.length > lim) out.push(`${NETWORK_LABELS[n] || n} limit is ${lim} chars; this post is ${text.length}.`);
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
  const text = await res.text();
  if (!res.ok) throw new Error(`Metricool brands lookup failed (${res.status}): ${text.trim().slice(0, 300)}`);
  let data: any = {};
  try { data = JSON.parse(text); } catch { throw new Error(`Metricool brands lookup returned no JSON: ${text.trim().slice(0, 200)}`); }
  const arr: any[] = Array.isArray(data) ? data : data.profiles || data.brands || [];
  return arr.map((b) => ({ id: String(b.blogId ?? b.id), label: String(b.label ?? b.title ?? b.brand ?? b.blogId ?? b.id) }));
}

// Metricool answers the normalize call with the hosted URL in one of several
// shapes: a bare string, a JSON-quoted string, or an object/array wrapping it.
// Anything else is an error — returning the URL we sent in would look like
// success while Metricool silently drops media it doesn't host, and the post
// would publish with no image.
export function parseNormalizedUrl(body: string): string {
  const pick = (v: any): string => {
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v)) return pick(v[0]);
    if (v && typeof v === "object") return pick(v.url ?? v.data ?? v.media ?? v.result);
    return "";
  };
  let found = "";
  try { found = pick(JSON.parse(body)); } catch { found = (body || "").trim(); }
  if (!/^https?:\/\//i.test(found)) {
    throw new Error(`Metricool did not return a media url for that image: ${(body || "").trim().slice(0, 200) || "(empty response)"}`);
  }
  return found;
}

// Normalize a PUBLIC media url so Metricool hosts it; returns the usable url.
// Endpoint confirmed against Metricool's API (GET /actions/normalize/image/url).
export async function normalizeMedia(c: MetricoolCreds, publicUrl: string): Promise<string> {
  const url = `${BASE}/actions/normalize/image/url?url=${encodeURIComponent(publicUrl)}&userId=${encodeURIComponent(c.userId)}${c.blogId ? `&blogId=${encodeURIComponent(c.blogId)}` : ""}`;
  const res = await fetch(url, { headers: mcHeaders(c) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Metricool media normalize failed (${res.status}): ${text.trim().slice(0, 300)}`);
  return parseNormalizedUrl(text);
}

export async function schedulePost(c: MetricoolCreds, payload: SchedulerPayload): Promise<string> {
  // Every scheduler call is scoped to a brand; without one we'd send `blogId=`
  // and Metricool would reject the post with a bare 400.
  if (!c.blogId) throw new Error("No Metricool brand picked — open Settings, load brands, and choose one.");
  const url = `${BASE}/v2/scheduler/posts?userId=${encodeURIComponent(c.userId)}&blogId=${encodeURIComponent(c.blogId)}`;
  const res = await fetch(url, { method: "POST", headers: mcHeaders(c), body: JSON.stringify(payload) });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* Metricool errors aren't always JSON */ }
  // Surface whatever Metricool actually said — a bare "(400)" leaves no way to
  // tell a bad brand from a rejected date from a network the brand can't post to.
  if (!res.ok) {
    const detail = data?.message || data?.error || text.trim().slice(0, 300);
    throw new Error(`Metricool scheduler failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return String(data.id ?? data.postId ?? "");
}
