// YouTube, through the official Data API: the church channel's videos (uploads and past
// live streams) and their captions, as a drafting source. Signing in as the channel owner
// once (Settings → Connect YouTube) stores a refresh token; captions.download needs it.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { getSetting, setSetting } from "./settings";
import { DEFAULT_TZ, formatMonthDayYear } from "./dates";

const API = "https://www.googleapis.com/youtube/v3";
const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
export const CALLBACK_PATH = "/api/youtube/callback";

export interface YtVideo {
  id: string; title: string; url: string; publishedAt: string; dateLine: string; label: string;
  /** "none" for an ordinary upload or a finished stream; "live" or "upcoming" can't have captions yet. */
  live: "none" | "live" | "upcoming"; wasLive: boolean;
}
export interface YtCaptions { videoId: string; trackKind: string; language: string; text: string }

// ── OAuth ──
const pending = new Map<string, number>(); // state -> expiry

export async function authUrl(pool: Pool, redirectUri: string): Promise<string> {
  const clientId = await getSetting(pool, "youtube_client_id");
  if (!clientId) throw new Error("Add the YouTube client ID and secret in Settings first.");
  const state = randomBytes(16).toString("hex");
  const now = Date.now();
  for (const [k, exp] of pending) if (exp < now) pending.delete(k);
  pending.set(state, now + 10 * 60 * 1000);
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString();
}

let cached: { token: string; until: number } | null = null;

async function tokenRequest(pool: Pool, params: Record<string, string>): Promise<any> {
  const [id, secret] = [await getSetting(pool, "youtube_client_id"), await getSetting(pool, "youtube_client_secret")];
  if (!id || !secret) throw new Error("Add the YouTube client ID and secret in Settings first.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }).toString(),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j.error === "invalid_grant") throw new Error("YouTube needs connecting again (Settings → Connect YouTube).");
    throw new Error("Google sign-in failed: " + (j.error_description || j.error || `HTTP ${res.status}`));
  }
  return j;
}

/** Finish the sign-in: swap the code for tokens and remember which channel it was. */
export async function finishAuth(pool: Pool, code: string, state: string, redirectUri: string): Promise<string> {
  const exp = pending.get(state);
  pending.delete(state);
  if (!exp || exp < Date.now()) throw new Error("That sign-in link expired. Start again from Settings.");
  const j = await tokenRequest(pool, { code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (!j.refresh_token) throw new Error("Google didn't give a lasting sign-in. Remove the app's access at myaccount.google.com/permissions and connect again.");
  await setSetting(pool, "youtube_refresh_token", j.refresh_token);
  cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  const ch = await channel(pool);
  await setSetting(pool, "youtube_channel_title", ch.title);
  return ch.title;
}

async function accessToken(pool: Pool): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const refresh = await getSetting(pool, "youtube_refresh_token");
  if (!refresh) throw new Error("YouTube isn't connected. Go to Settings → Connect YouTube.");
  const j = await tokenRequest(pool, { refresh_token: refresh, grant_type: "refresh_token" });
  cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  return cached.token;
}

export async function disconnect(pool: Pool): Promise<void> {
  await setSetting(pool, "youtube_refresh_token", "");
  await setSetting(pool, "youtube_channel_title", "");
  cached = null;
}

async function yt(pool: Pool, path: string, params: Record<string, string>, raw = false): Promise<any> {
  const res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, { headers: { authorization: "Bearer " + (await accessToken(pool)) } });
  if (!res.ok) {
    const j: any = await res.json().catch(() => ({}));
    const reason = j.error?.errors?.[0]?.reason || "";
    if (reason === "quotaExceeded") throw new Error("YouTube's daily limit for this app is used up. Try again tomorrow.");
    if (res.status === 403 && path.startsWith("captions/")) throw new Error("YouTube won't hand over these captions. Is the video on the connected channel?");
    throw new Error("YouTube: " + (j.error?.message || `HTTP ${res.status}`));
  }
  return raw ? res.text() : res.json();
}

async function channel(pool: Pool): Promise<{ title: string; uploads: string }> {
  const j = await yt(pool, "channels", { part: "snippet,contentDetails", mine: "true" });
  const c = j.items?.[0];
  if (!c) throw new Error("That Google account has no YouTube channel. Connect again and pick the church's channel.");
  return { title: c.snippet.title, uploads: c.contentDetails.relatedPlaylists.uploads };
}

// ── Videos ──
export function videoOf(v: any, tz: string): YtVideo {
  const live = (["live", "upcoming"].includes(v.snippet?.liveBroadcastContent) ? v.snippet.liveBroadcastContent : "none") as YtVideo["live"];
  const wasLive = !!v.liveStreamingDetails;
  const when = v.liveStreamingDetails?.actualStartTime || v.liveStreamingDetails?.scheduledStartTime || v.snippet?.publishedAt || "";
  const day = formatMonthDayYear(when, tz);
  const dateLine = live === "live" ? "live now" : live === "upcoming" ? (day ? "scheduled for " + day : "scheduled")
    : (wasLive ? "streamed " : "uploaded ") + day;
  return {
    id: v.id, title: v.snippet?.title || "(untitled)", url: "https://www.youtube.com/watch?v=" + v.id, publishedAt: when,
    dateLine: dateLine.trim(), label: `${v.snippet?.title || "(untitled)"} — ${dateLine.trim()}`, live, wasLive,
  };
}

/** The channel's latest 50 videos, newest first, uploads and streams alike. */
export async function listVideos(pool: Pool): Promise<YtVideo[]> {
  const { uploads } = await channel(pool);
  const items = await yt(pool, "playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "50" });
  const ids = (items.items || []).map((i: any) => i.contentDetails.videoId).filter(Boolean);
  if (!ids.length) return [];
  const tz = (await getSetting(pool, "default_timezone")) || DEFAULT_TZ;
  const j = await yt(pool, "videos", { part: "snippet,liveStreamingDetails", id: ids.join(",") });
  return (j.items || []).map((v: any) => videoOf(v, tz)).sort((a: YtVideo, b: YtVideo) => (a.publishedAt < b.publishedAt ? 1 : -1));
}

export async function getVideo(pool: Pool, id: string): Promise<YtVideo> {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error("That isn't a YouTube video id.");
  const j = await yt(pool, "videos", { part: "snippet,liveStreamingDetails", id });
  if (!j.items?.[0]) throw new Error("That YouTube video is gone or private to another channel.");
  return videoOf(j.items[0], (await getSetting(pool, "default_timezone")) || DEFAULT_TZ);
}

// ── Captions ──
/** Captions as plain text: cue timings, settings and inline tags dropped, rolling repeats removed. */
export function captionsToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.replace(/\r/g, "").split("\n")) {
    const l = raw.trim();
    if (!l || /^WEBVTT/.test(l) || /^(Kind|Language|NOTE|STYLE|REGION)\b/.test(l) || /^\d+$/.test(l) || /-->/.test(l)
      || /^\d+:\d+:\d+[.,]\d+,\d+:\d+:\d+[.,]\d+$/.test(l)) continue;
    const text = l.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/^>>\s*/, "").replace(/\[(music|applause|laughter)\]/gi, "").replace(/\s+/g, " ").trim();
    if (!text || text === lines[lines.length - 1]) continue;
    lines.push(text);
  }
  // Join into flowing text, with a paragraph break every ~12 lines so Claude can read it.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 12) out.push(lines.slice(i, i + 12).join(" "));
  return out.join("\n\n");
}

/** Human-made English captions win over YouTube's automatic ones; then any English, then anything. */
export function pickTrack(tracks: Array<{ id: string; snippet: { trackKind: string; language: string; status?: string } }>) {
  const usable = tracks.filter((t) => !t.snippet.status || t.snippet.status === "serving");
  const en = (t: { snippet: { language: string } }) => /^en\b/i.test(t.snippet.language || "");
  return usable.find((t) => en(t) && t.snippet.trackKind !== "asr")
    || usable.find((t) => en(t)) || usable.find((t) => t.snippet.trackKind !== "asr") || usable[0] || null;
}

const misses = new Map<string, { at: number; error: string }>(); // videoId -> recent "no captions" answer

/**
 * The video's captions, fetched once and kept (a download costs 200 of the 10,000 daily quota units).
 * `refresh` fetches again, e.g. after fixing captions in YouTube Studio.
 */
export async function getCaptions(pool: Pool, videoId: string, refresh = false): Promise<YtCaptions> {
  if (!refresh) {
    const r = await pool.query("SELECT track_kind, language, text FROM youtube_captions WHERE video_id = $1", [videoId]);
    if (r.rows[0]) return { videoId, trackKind: r.rows[0].track_kind, language: r.rows[0].language, text: r.rows[0].text };
    const miss = misses.get(videoId);
    if (miss && Date.now() - miss.at < 10 * 60 * 1000) throw new Error(miss.error);
  }
    const list = await yt(pool, "captions", { part: "snippet", videoId });
    const track = pickTrack(list.items || []);
    if (!track) {
      const error = "YouTube has no captions for this video yet. Automatic captions usually appear a few hours after a stream ends.";
      misses.set(videoId, { at: Date.now(), error });
      throw new Error(error);
    }
    const text = captionsToText(await yt(pool, "captions/" + encodeURIComponent(track.id), { tfmt: "vtt" }, true));
    if (!text.trim()) throw new Error("This video's captions are empty.");
    await pool.query(
      `INSERT INTO youtube_captions (video_id, track_kind, language, text, fetched_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (video_id) DO UPDATE SET track_kind = EXCLUDED.track_kind, language = EXCLUDED.language, text = EXCLUDED.text, fetched_at = now()`,
      [videoId, track.snippet.trackKind, track.snippet.language, text]);
    misses.delete(videoId);
    return { videoId, trackKind: track.snippet.trackKind, language: track.snippet.language, text };
}
