import { Pool } from "pg";
import { getSetting, setSetting } from "./settings";
import { getMedia } from "./media";

/**
 * "Put this on the screen right now." One media item, looping, over whatever
 * the schedule says, until somebody clears it. It wakes the TV if the
 * schedule had it off, and clearing it hands the screen back to the schedule
 * -- or turns the TV off again if nothing is scheduled.
 *
 * The emergency takeover still outranks it.
 */
export interface PlayNow {
  active: boolean;
  mediaId: number;
  /** Filled in by getPlayNow from the media row; parsePlayNow leaves it "". */
  title: string;
  startedAt: string | null;
  startedBy: string;
}

export const NO_PLAY_NOW: PlayNow = {
  active: false,
  mediaId: 0,
  title: "",
  startedAt: null,
  startedBy: "",
};

const KEY = "play_now";

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
  const mediaId = Number(value.mediaId);
  if (!Number.isInteger(mediaId) || mediaId <= 0) return NO_PLAY_NOW;
  return {
    active: true,
    mediaId,
    title: "",
    startedAt: value.startedAt ? String(value.startedAt) : null,
    startedBy: String(value.startedBy ?? "").slice(0, 200),
  };
}

/**
 * The live Play now, or none.
 *
 * An item that was deleted, or whose conversion failed, ends it: the screen
 * goes back to the schedule rather than sitting black. An item merely being
 * re-rendered (a notice edited in place goes back to pending) keeps it: the
 * screen is black for a moment, but the TV stays on -- fixing a typo must not
 * switch the television off and on again.
 */
export async function getPlayNow(pool: Pool): Promise<PlayNow> {
  const stored = parsePlayNow(await getSetting(pool, KEY));
  if (!stored.active) return NO_PLAY_NOW;
  const media = await getMedia(pool, stored.mediaId);
  if (!media || media.status === "failed") return NO_PLAY_NOW;
  return { ...stored, title: media.title };
}

/** Replaces any Play now already running: there is only ever one. */
export async function startPlayNow(pool: Pool, mediaId: number, by: string): Promise<PlayNow> {
  const startedAt = new Date().toISOString();
  await setSetting(
    pool,
    KEY,
    JSON.stringify({ active: true, mediaId, startedAt, startedBy: by.slice(0, 200) })
  );
  return getPlayNow(pool);
}

export async function clearPlayNow(pool: Pool): Promise<void> {
  await setSetting(pool, KEY, "");
}
