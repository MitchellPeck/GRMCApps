import { Pool } from "pg";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { getSetting, setSetting } from "./settings";
import { config } from "./config";
import { renderNotice } from "./render-notice";

/**
 * An override that puts one message on the screen NOW, over everything that is
 * scheduled, until somebody clears it. Lockdown, severe weather, "the service
 * has moved to the chapel".
 *
 * Deliberately rendered by the player as text rather than going through the
 * conversion pipeline: an emergency must not wait on LibreOffice, and it must
 * work even if the queue is wedged or the media volume is unreadable. It is
 * also the one thing here that ignores operating hours — a dark screen is no
 * use to somebody being told to evacuate.
 */
export interface Takeover {
  active: boolean;
  headline: string;
  body: string;
  /** Renders on a red field rather than the house navy. */
  urgent: boolean;
  startedAt: string | null;
  startedBy: string;
  /**
   * The message rasterised to a JPEG. The browser player draws the text
   * itself, but playout.py — which is what actually feeds the narthex screen
   * through the Blackmagic card — only decodes pictures and video. Without
   * this the emergency would appear in a browser and nowhere else.
   */
  imagePath: string;
}

export const NO_TAKEOVER: Takeover = {
  active: false,
  headline: "",
  body: "",
  urgent: true,
  startedAt: null,
  startedBy: "",
  imagePath: "",
};

const KEY = "takeover";

export function parseTakeover(raw: string): Takeover {
  if (!raw) return NO_TAKEOVER;
  let value: Partial<Takeover>;
  try {
    value = JSON.parse(raw) as Partial<Takeover>;
  } catch {
    // A malformed row must not be able to pin a message on the screen, nor
    // throw on every poll.
    return NO_TAKEOVER;
  }
  if (!value || value.active !== true) return NO_TAKEOVER;
  const headline = String(value.headline ?? "").slice(0, 120).trim();
  const body = String(value.body ?? "").slice(0, 400).trim();
  // Nothing to say is not a takeover.
  if (!headline && !body) return NO_TAKEOVER;
  return {
    active: true,
    headline,
    body,
    urgent: value.urgent !== false,
    startedAt: value.startedAt ? String(value.startedAt) : null,
    startedBy: String(value.startedBy ?? "").slice(0, 200),
    imagePath: String(value.imagePath ?? ""),
  };
}

export async function getTakeover(pool: Pool): Promise<Takeover> {
  return parseTakeover(await getSetting(pool, KEY));
}

/** The URL path the rendered message is served at, versioned so a new
 *  takeover is never served from a client's cache of the last one. */
export function takeoverImageName(startedAt: string): string {
  return `${Date.parse(startedAt) || 0}.jpg`;
}

export async function startTakeover(
  pool: Pool,
  fields: { headline: string; body: string; urgent: boolean },
  by: string
): Promise<Takeover> {
  const startedAt = new Date().toISOString();
  const takeover: Takeover = {
    active: true,
    headline: fields.headline.slice(0, 120).trim(),
    body: fields.body.slice(0, 400).trim(),
    urgent: fields.urgent,
    startedAt,
    startedBy: by,
    imagePath: "",
  };

  // Rendered HERE and now, not on the conversion queue: the queue may be an
  // hour into a video, and an emergency cannot wait behind it.
  const dir = join(config.dataDir, "takeover");
  try {
    const drawn = await renderNotice(
      { headline: takeover.headline, body: takeover.body, footnote: "" },
      dir,
      { theme: fields.urgent ? "urgent" : "navy" }
    );
    const { rename } = await import("node:fs/promises");
    const target = join(dir, takeoverImageName(startedAt));
    await rename(drawn.path, target);
    takeover.imagePath = target;
  } catch {
    // A failed render must NOT stop the message going up. The browser player
    // draws the text itself, and a screen fed through the card shows black —
    // which is better than leaving last week's announcements on the wall
    // during an evacuation.
  }

  await setSetting(pool, KEY, JSON.stringify(takeover));
  return takeover;
}

export async function clearTakeover(pool: Pool): Promise<void> {
  const previous = await getTakeover(pool);
  await setSetting(pool, KEY, "");
  if (previous.imagePath) await rm(previous.imagePath, { force: true }).catch(() => {});
}
