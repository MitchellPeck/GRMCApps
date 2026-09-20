import { Pool } from "pg";
import { getSetting } from "./settings";
import { DEFAULT_TZ, formatMonthDayYear, localDateIn } from "./dates";

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…",
};

// Buzzsprout stores descriptions as HTML. Claude reads the text, not the
// markup, and paragraph breaks are the only structure worth carrying over.
export function htmlToText(html: string): string {
  let s = html || "";
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote)\s*>/gi, "\n\n");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
  s = s.replace(/&([a-zA-Z]+);/g, (m, name) => {
    const key = String(name).toLowerCase();
    return key in ENTITIES ? ENTITIES[key] : m;
  });
  s = s.replace(/[ \t]+/g, " ");
  s = s.split("\n").map((line) => line.trim()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Live means Buzzsprout is actually serving it: not private, and its publish
// moment has passed. An episode scheduled for Sunday is neither.
export function isPublished(ep: { published_at: string; private: boolean }, now: Date = new Date()): boolean {
  if (ep.private) return false;
  const at = new Date(ep.published_at || "");
  if (isNaN(at.getTime())) return false;
  return at.getTime() <= now.getTime();
}

// One honest line about where this episode stands, in the same spirit as
// campaignDateLine: an episode that has not dropped is never called published.
export function episodeDateLine(
  ep: { published_at: string; private: boolean; episode_number: number | null },
  tz: string,
  now: Date = new Date()
): string {
  const parts: string[] = [];
  if (ep.episode_number) parts.push("Episode " + ep.episode_number);
  const when = formatMonthDayYear(ep.published_at || "", tz);
  if (ep.private) parts.push("private, not published");
  else if (isPublished(ep, now)) parts.push(when ? "published " + when : "published");
  else parts.push(when ? "scheduled for " + when : "not yet published");
  return parts.join(" · ");
}

// A show that publishes to its own site sets custom_url; everyone else gets
// Buzzsprout's canonical episode page. Never guess without a podcast id.
export function listenUrlFor(ep: { id: number; custom_url: string | null }, podcastId: string): string {
  const custom = (ep.custom_url || "").trim();
  if (custom) return custom;
  if (!podcastId || !ep.id) return "";
  return `https://www.buzzsprout.com/${podcastId}/episodes/${ep.id}`;
}

export function durationLabel(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return `${totalMin} min`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${hr} hr ${min} min` : `${hr} hr`;
}

export interface BuzzsproutRow {
  id: number; title: string; description: string; artwork_url?: string;
  custom_url: string | null; published_at: string; duration: number;
  episode_number: number | null; season_number: number | null; private: boolean;
}

export interface Episode {
  id: number; title: string; description: string; listenUrl: string; artworkUrl: string;
  publishedAt: string; publishDate: string; isPublished: boolean; isPrivate: boolean;
  episodeNumber: number | null; seasonNumber: number | null;
  durationLabel: string; dateLine: string; label: string;
}

export function toEpisode(raw: BuzzsproutRow, podcastId: string, tz: string, now: Date = new Date()): Episode {
  const at = new Date(raw.published_at || "");
  const title = raw.title || "(untitled episode)";
  return {
    id: raw.id,
    title,
    description: htmlToText(raw.description || "").substring(0, 4000),
    listenUrl: listenUrlFor(raw, podcastId),
    artworkUrl: raw.artwork_url || "",
    publishedAt: raw.published_at || "",
    publishDate: isNaN(at.getTime()) ? "" : localDateIn(tz, at),
    isPublished: isPublished(raw, now),
    isPrivate: !!raw.private,
    episodeNumber: raw.episode_number,
    seasonNumber: raw.season_number,
    durationLabel: durationLabel(raw.duration),
    dateLine: episodeDateLine(raw, tz, now),
    label: raw.episode_number ? `#${raw.episode_number} \u2014 ${title}` : title,
  };
}

async function buzzsproutGet(pool: Pool, path: string): Promise<any> {
  const token = await getSetting(pool, "buzzsprout_api_token");
  if (!token) throw new Error("Buzzsprout API token not configured. Go to Settings.");
  const res = await fetch("https://www.buzzsprout.com/api" + path, {
    headers: {
      Authorization: `Token token=${token}`,
      "User-Agent": "GRMCApps social-posts",
    },
  });
  if (res.status === 401 || res.status === 403) throw new Error("Buzzsprout rejected the API token. Check it in Settings.");
  if (res.status === 404) throw new Error("Buzzsprout could not find that podcast or episode. Check the podcast ID in Settings.");
  // 60 requests per minute per token; say so rather than showing a bare 429.
  if (res.status === 429) throw new Error("Buzzsprout rate limit reached (60 requests a minute). Try again shortly.");
  if (!res.ok) throw new Error(`Buzzsprout returned ${res.status}.`);
  return res.json();
}

async function podcastContext(pool: Pool): Promise<{ podcastId: string; tz: string }> {
  // Token first: with nothing configured, that is the field to fill in first,
  // and naming the podcast instead sends you to the wrong box.
  if (!(await getSetting(pool, "buzzsprout_api_token")))
    throw new Error("Buzzsprout API token not configured. Go to Settings.");
  const podcastId = await getSetting(pool, "buzzsprout_podcast_id");
  if (!podcastId) throw new Error("No Buzzsprout podcast selected. Go to Settings.");
  return { podcastId, tz: (await getSetting(pool, "default_timezone")) || DEFAULT_TZ };
}

export interface PodcastOption { id: string; title: string; }

// Buzzsprout exposes the account's shows, so the podcast ID is picked from a
// list rather than copied out of a dashboard URL.
export async function listPodcasts(pool: Pool): Promise<PodcastOption[]> {
  const body = await buzzsproutGet(pool, "/podcasts.json");
  const rows: any[] = Array.isArray(body) ? body : body.podcasts || [];
  return rows.map((p) => ({ id: String(p.id), title: p.title || `Podcast ${p.id}` }));
}

export async function listEpisodes(pool: Pool, limit = 25): Promise<Episode[]> {
  const { podcastId, tz } = await podcastContext(pool);
  const body = await buzzsproutGet(pool, `/${podcastId}/episodes.json`);
  const rows: any[] = Array.isArray(body) ? body : body.episodes || [];
  const now = new Date();
  return rows
    .slice()
    .sort((a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime())
    .slice(0, limit)
    .map((r) => toEpisode(r as BuzzsproutRow, podcastId, tz, now));
}

export async function getEpisode(pool: Pool, id: string | number): Promise<Episode> {
  const { podcastId, tz } = await podcastContext(pool);
  const row = await buzzsproutGet(pool, `/${podcastId}/episodes/${id}.json`);
  return toEpisode(row as BuzzsproutRow, podcastId, tz, new Date());
}
