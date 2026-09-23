import { createHash } from "node:crypto";
import { AppSettings } from "./settings";

export type MediaKind = "image" | "video" | "deck";
export type Fit = "contain" | "cover";

export interface PlanMedia {
  id: number;
  kind: MediaKind;
  title: string;
  status: string;
  pageCount: number;
  durationMs: number | null;
}

export interface PlanItem {
  media: PlanMedia;
  /** Per-item override in seconds. 0 = fall back to the playlist, then the app. */
  seconds: number;
  /** Per-item override. '' = fall back. */
  fit: string;
  enabled: boolean;
  /** Inclusive 'YYYY-MM-DD' bounds. null = no bound at that end. */
  showFrom: string | null;
  showUntil: string | null;
}

/**
 * Is this item inside its own date window on the given local date?
 *
 * Compared as 'YYYY-MM-DD' strings, which sort lexicographically in the same
 * order they sort chronologically — no timezone arithmetic, because the
 * caller has already decided which local day it is.
 */
export function itemAiring(item: PlanItem, todayKey: string): boolean {
  if (item.showFrom && todayKey < item.showFrom) return false;
  if (item.showUntil && todayKey > item.showUntil) return false;
  return true;
}

export interface PlaylistDefaults {
  id: number;
  name: string;
  imageSeconds: number;
  slideSeconds: number;
  transition: string;
  fit: string;
  footerText: string;
  shuffle: boolean;
}

/**
 * One thing on the screen for one stretch of time. Everything a document or a
 * deck ever was is already an image by the time it gets here — the player only
 * ever has to show a picture or play a video, which is what keeps it small
 * enough to trust running unattended for months.
 */
export interface Frame {
  kind: "image" | "video";
  url: string;
  /** null on a video: play it to its natural end. */
  ms: number | null;
  fit: Fit;
  mediaId: number;
  page: number;
  title: string;
}

const fitOf = (...values: string[]): Fit => {
  for (const v of values) if (v === "contain" || v === "cover") return v;
  return "contain";
};

// Stable, seeded shuffle. A fresh random order on every poll would change the
// plan revision every few seconds and restart the TV mid-slide; seeding from
// the playlist and the moment its schedule entry began keeps one airing in one
// order, while the next airing differs.
function seededShuffle<T>(list: T[], seed: number): T[] {
  const out = list.slice();
  let s = (seed || 1) >>> 0;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildFrames(
  items: PlanItem[],
  playlist: PlaylistDefaults,
  settings: AppSettings,
  seed = 0,
  todayKey = ""
): Frame[] {
  // Anything still converting, or that failed to convert, is skipped rather
  // than shown as a broken tile — the rest of the loop carries on. So is
  // anything outside its own show-from/show-until window.
  const playable = items.filter(
    (i) =>
      i.enabled &&
      i.media.status === "ready" &&
      (!todayKey || itemAiring(i, todayKey))
  );
  const ordered = playlist.shuffle ? seededShuffle(playable, seed) : playable;

  const imageMs = (i: PlanItem) =>
    (i.seconds || playlist.imageSeconds || settings.imageSeconds) * 1000;
  const slideMs = (i: PlanItem) =>
    (i.seconds || playlist.slideSeconds || settings.slideSeconds) * 1000;

  const frames: Frame[] = [];
  for (const item of ordered) {
    const fit = fitOf(item.fit, playlist.fit, settings.fit);
    const m = item.media;
    if (m.kind === "image") {
      frames.push({
        kind: "image",
        url: `/api/player/media/${m.id}/file`,
        ms: imageMs(item),
        fit,
        mediaId: m.id,
        page: 0,
        title: m.title,
      });
    } else if (m.kind === "video") {
      frames.push({
        kind: "video",
        url: `/api/player/media/${m.id}/file`,
        // A per-item duration on a video is a cap, not a stretch: it cuts a
        // long clip short. Left at 0 the clip plays to its own end.
        ms: item.seconds > 0 ? item.seconds * 1000 : null,
        fit,
        mediaId: m.id,
        page: 0,
        title: m.title,
      });
    } else {
      for (let page = 1; page <= m.pageCount; page++) {
        frames.push({
          kind: "image",
          url: `/api/player/media/${m.id}/page/${page}`,
          ms: slideMs(item),
          fit,
          mediaId: m.id,
          page,
          title: m.pageCount > 1 ? `${m.title} (${page}/${m.pageCount})` : m.title,
        });
      }
    }
  }
  return frames;
}

export interface PlanDisplay {
  background: string;
  transition: "none" | "fade";
  transitionMs: number;
  clock: AppSettings["clock"];
  clockPosition: AppSettings["clockPosition"];
  footerText: string;
  rotation: number;
  pollSeconds: number;
  idleMessage: string;
  loopSingleVideo: boolean;
}

export interface PlanPower {
  /** false = show nothing at all: the narthex is outside its opening hours. */
  on: boolean;
  changesAt: string | null;
}

export interface Plan {
  revision: string;
  /** Changes whenever a different schedule entry takes the screen. */
  sourceKey: string;
  serverTime: string;
  playlistId: number | null;
  playlistName: string;
  entryId: number | null;
  entryLabel: string;
  endsAt: string | null;
  changesAt: string | null;
  display: PlanDisplay;
  power: PlanPower;
  frames: Frame[];
}

// Everything the TV renders from, hashed. The player compares revisions and
// only rebuilds when one changed, so a poll every few seconds costs nothing.
export function planRevision(plan: Omit<Plan, "revision" | "serverTime" | "changesAt">): string {
  const material = JSON.stringify({
    sourceKey: plan.sourceKey,
    playlistId: plan.playlistId,
    entryId: plan.entryId,
    display: plan.display,
    // `on` only: `changesAt` is a moving timestamp and would churn the
    // revision on every poll.
    power: plan.power.on,
    frames: plan.frames,
  });
  return createHash("sha1").update(material).digest("hex").slice(0, 16);
}
