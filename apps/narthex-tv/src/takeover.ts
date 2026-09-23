import { Pool } from "pg";
import { getSetting, setSetting } from "./settings";

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
}

export const NO_TAKEOVER: Takeover = {
  active: false,
  headline: "",
  body: "",
  urgent: true,
  startedAt: null,
  startedBy: "",
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
  };
}

export async function getTakeover(pool: Pool): Promise<Takeover> {
  return parseTakeover(await getSetting(pool, KEY));
}

export async function startTakeover(
  pool: Pool,
  fields: { headline: string; body: string; urgent: boolean },
  by: string
): Promise<Takeover> {
  const takeover: Takeover = {
    active: true,
    headline: fields.headline.slice(0, 120).trim(),
    body: fields.body.slice(0, 400).trim(),
    urgent: fields.urgent,
    startedAt: new Date().toISOString(),
    startedBy: by,
  };
  await setSetting(pool, KEY, JSON.stringify(takeover));
  return takeover;
}

export async function clearTakeover(pool: Pool): Promise<void> {
  await setSetting(pool, KEY, "");
}
