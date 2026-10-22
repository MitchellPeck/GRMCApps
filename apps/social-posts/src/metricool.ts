import { Pool } from "pg";
import { getSetting } from "./settings";

export interface PayloadInput {
  text: string;
  networks: string[];
  dateTime: string;
  timezone: string;
  /** Every image (or video) to attach, in order; several make a carousel. */
  mediaUrls: string[];
  /** "scheduled" publishes itself at dateTime; "draft" waits in Metricool for a human. */
  publish: PublishMode;
}
export type PublishMode = "scheduled" | "draft";
export function isPublishMode(v: unknown): v is PublishMode { return v === "scheduled" || v === "draft"; }
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
  // is its draft state, and `draft` has to agree with it or the post sits in
  // the planner forever. The sender chooses, and it holds for every network.
  const autoPublish = i.publish === "scheduled";
  const payload: SchedulerPayload = {
    publicationDate: { dateTime: i.dateTime, timezone: i.timezone },
    text: i.text,
    providers: i.networks.map((n) => ({ network: n })),
    autoPublish,
    draft: !autoPublish,
  };
  if (i.networks.includes("facebook")) payload.facebookData = { type: "POST" };
  if (i.mediaUrls.length) payload.media = i.mediaUrls.slice();
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
  // The live reply didn't carry the id at the top level, and its real shape is unknown, so try each
  // likely place. No id is fine: the post-send sync relinks it from the planner.
  const id = data?.id ?? data?.postId ?? data?.data?.id ?? data?.data?.postId
    ?? (Array.isArray(data?.data) ? data.data[0]?.id : undefined);
  return String(id ?? "");
}

export interface McProvider { network: string; status: string; detailedStatus?: string; publicUrl?: string }

/**
 * Has Metricool published this post? Each network reports a status; a post is
 * out only when every one of them is (or has a public link). Failures name the
 * network and Metricool's reason. Anything unrecognised is "unknown", and
 * callers change nothing on an unknown.
 */
export function publicationState(post: { providers?: McProvider[] }): { state: "published" | "failed" | "pending" | "unknown"; detail: string } {
  const provs = post.providers || [];
  if (!provs.length) return { state: "unknown", detail: "" };
  const failed = provs.filter((p) => /ERROR|FAIL|REJECT/i.test(p.status || ""));
  if (failed.length) return { state: "failed", detail: failed.map((p) => `${p.network}: ${p.detailedStatus || p.status}`).join("; ") };
  if (provs.every((p) => /^PUBLISHED$/i.test(p.status || "") || !!p.publicUrl)) return { state: "published", detail: "" };
  if (provs.some((p) => /PENDING|SCHEDULED|QUEUED|DRAFT|PROCESSING/i.test(p.status || ""))) return { state: "pending", detail: "" };
  return { state: "unknown", detail: "" };
}

/** The planner list's body exactly as Metricool sent it, unparsed (the probe saves it as a fixture). */
export async function fetchSchedulerPostsRaw(c: MetricoolCreds, start: string, end: string, timezone: string): Promise<string> {
  if (!c.blogId) throw new Error("No Metricool brand picked — open Settings, load brands, and choose one.");
  const qs = new URLSearchParams({ userId: c.userId, blogId: c.blogId, start: `${start}T00:00:00`, end: `${end}T23:59:59`, timezone, extendedRange: "true" });
  // Bounded: the sync runs one at a time, so a stalled call would hold up every later run.
  const res = await fetch(`${BASE}/v2/scheduler/posts?${qs}`, { headers: mcHeaders(c), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Metricool answered ${res.status}: ${text.trim().slice(0, 200)}`);
  return text;
}

/** Posts in Metricool's planner between two dates (YYYY-MM-DD), published or not. */
export async function listSchedulerPosts(c: MetricoolCreds, start: string, end: string, timezone: string): Promise<Array<{ id: string; providers: McProvider[] }>> {
  const text = await fetchSchedulerPostsRaw(c, start, end, timezone);
  let data: any = {};
  try { data = JSON.parse(text); } catch { throw new Error("Metricool's planner list wasn't readable."); }
  const rows: any[] = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
  return rows.map((p) => ({ id: String(p.id ?? ""), providers: Array.isArray(p.providers) ? p.providers : [] }));
}
