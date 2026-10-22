import { Pool } from "pg";
import { getSetting, setSetting } from "./settings";
import { getMedia } from "./media";
import { getPlaylist } from "./playlists";

/**
 * "Put this on the screen right now." One media item or one playlist,
 * looping, over whatever the schedule says, until somebody clears it. It wakes
 * the TV if the schedule had it off, and clearing it hands the screen back to
 * the schedule -- or turns the TV off again if nothing is scheduled.
 *
 * The emergency takeover still outranks it.
 */
export interface PlayNow {
  active: boolean;
  /** Exactly one of mediaId and playlistId is set while active; the other is 0. */
  mediaId: number;
  playlistId: number;
  /** Filled in by getPlayNow from the media or playlist row; parsePlayNow leaves it "". */
  title: string;
  startedAt: string | null;
  startedBy: string;
}

export type PlayNowTarget = { mediaId: number } | { playlistId: number };

export const NO_PLAY_NOW: PlayNow = {
  active: false,
  mediaId: 0,
  playlistId: 0,
  title: "",
  startedAt: null,
  startedBy: "",
};

const KEY = "play_now";

const positiveInt = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

export function parsePlayNow(raw: string): PlayNow {
  if (!raw) return NO_PLAY_NOW;
  let value: Partial<PlayNow>;
  try {
    value = JSON.parse(raw) as Partial<PlayNow>;
  } catch {
    // A malformed row must not pin anything on the screen, nor throw on
    // every poll.
    return NO_PLAY_NOW;
  }
  if (!value || value.active !== true) return NO_PLAY_NOW;
  const mediaId = positiveInt(value.mediaId);
  const playlistId = mediaId ? 0 : positiveInt(value.playlistId);
  if (!mediaId && !playlistId) return NO_PLAY_NOW;
  return {
    active: true,
    mediaId,
    playlistId,
    title: "",
    startedAt: value.startedAt ? String(value.startedAt) : null,
    startedBy: String(value.startedBy ?? "").slice(0, 200),
  };
}

/**
 * The live Play now, or none.
 *
 * An item that was deleted, or whose conversion failed, ends it: the screen
 * goes back to the schedule rather than sitting black. So does a playlist that
 * was deleted or archived. An item merely being re-rendered (a notice edited
 * in place goes back to pending) keeps it: the screen is black for a moment,
 * but the TV stays on -- fixing a typo must not switch the television off and
 * on again.
 */
export async function getPlayNow(pool: Pool): Promise<PlayNow> {
  const stored = parsePlayNow(await getSetting(pool, KEY));
  if (!stored.active) return NO_PLAY_NOW;
  if (stored.playlistId) {
    const playlist = await getPlaylist(pool, stored.playlistId);
    if (!playlist || playlist.archived) return NO_PLAY_NOW;
    return { ...stored, title: playlist.name };
  }
  const media = await getMedia(pool, stored.mediaId);
  if (!media || media.status === "failed") return NO_PLAY_NOW;
  return { ...stored, title: media.title };
}

/** Replaces any Play now already running: there is only ever one. */
export async function startPlayNow(pool: Pool, target: PlayNowTarget, by: string): Promise<PlayNow> {
  const startedAt = new Date().toISOString();
  await setSetting(
    pool,
    KEY,
    JSON.stringify({ active: true, ...target, startedAt, startedBy: by.slice(0, 200) })
  );
  return getPlayNow(pool);
}

export async function clearPlayNow(pool: Pool): Promise<void> {
  await setSetting(pool, KEY, "");
}
