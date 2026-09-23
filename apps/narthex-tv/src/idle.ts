import { Pool } from "pg";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { getMedia } from "./media";
import { getSetting, setSetting } from "./settings";
import { renderNotice } from "./render-notice";

/**
 * The screen when there is genuinely nothing to show — no schedule, no default
 * playlist, nothing playable in it.
 *
 * Rendered on the server, like the takeover and for the same reason: the
 * narthex screen is fed through the Blackmagic card by playout.py, which
 * decodes pictures and video and cannot draw text. An idle screen that existed
 * only in the browser would leave the actual wall black.
 */
export interface IdleSettings {
  headline: string;
  message: string;
  theme: string;
  /** A media row to use as the logo. 0 = none. */
  logoMediaId: number;
  /** Show the built-in seal when there is no logo. */
  showMark: boolean;
}

export const DEFAULT_IDLE: IdleSettings = {
  headline: "",
  message: "",
  theme: "navy",
  logoMediaId: 0,
  showMark: true,
};

const KEYS = {
  headline: "idle_headline",
  message: "idle_message",
  theme: "idle_theme",
  logo: "idle_logo_media_id",
  mark: "idle_show_mark",
};

export async function loadIdle(pool: Pool): Promise<IdleSettings> {
  const n = Number(await getSetting(pool, KEYS.logo));
  const mark = await getSetting(pool, KEYS.mark);
  return {
    headline: (await getSetting(pool, KEYS.headline)).slice(0, 120),
    // Falls back to the older idle_message key so an existing setting is kept.
    message: (await getSetting(pool, KEYS.message)).slice(0, 300),
    theme: (await getSetting(pool, KEYS.theme)) || DEFAULT_IDLE.theme,
    logoMediaId: Number.isInteger(n) && n > 0 ? n : 0,
    showMark: mark === "" ? DEFAULT_IDLE.showMark : mark === "true",
  };
}

export async function saveIdle(pool: Pool, patch: Partial<IdleSettings>): Promise<void> {
  if (patch.headline !== undefined) await setSetting(pool, KEYS.headline, patch.headline.slice(0, 120));
  if (patch.message !== undefined) await setSetting(pool, KEYS.message, patch.message.slice(0, 300));
  if (patch.theme !== undefined) await setSetting(pool, KEYS.theme, patch.theme);
  if (patch.logoMediaId !== undefined) await setSetting(pool, KEYS.logo, String(patch.logoMediaId || 0));
  if (patch.showMark !== undefined) await setSetting(pool, KEYS.mark, String(patch.showMark));
}

/**
 * A stable name for one configuration of the idle screen.
 *
 * Everything that changes the picture is in it, so a settings change produces
 * a different file — which is also what stops a screen serving the previous
 * idle slide out of its cache.
 */
export function idleSlideName(idle: IdleSettings, logoStamp: string): string {
  // showMark is deliberately absent: it governs only the player's offline
  // fallback seal, never the rendered picture, so it must not change the name.
  const material = JSON.stringify([
    idle.headline, idle.message, idle.theme, idle.logoMediaId, logoStamp,
  ]);
  return createHash("sha1").update(material).digest("hex").slice(0, 16) + ".jpg";
}

/**
 * Nothing to draw. The built-in seal is NOT content: it is the mark the
 * player falls back to when it cannot reach the server, not a designed slide,
 * and rendering it would put a lone serif letter on the wall.
 */
export function idleIsBlank(idle: IdleSettings): boolean {
  return !idle.headline.trim() && !idle.message.trim() && !idle.logoMediaId;
}

export interface IdleSlide {
  name: string;
  path: string;
}

// One render at a time per name, so a dozen screens polling together do not
// each start ffmpeg on the same file.
const inFlight = new Map<string, Promise<IdleSlide | null>>();

export async function ensureIdleSlide(pool: Pool): Promise<IdleSlide | null> {
  const idle = await loadIdle(pool);
  if (idleIsBlank(idle)) return null;

  let logoPath: string | undefined;
  let logoStamp = "";
  if (idle.logoMediaId) {
    const media = await getMedia(pool, idle.logoMediaId);
    if (media?.play_path && media.status === "ready") {
      logoPath = media.play_path;
      logoStamp = String(media.updated_at ?? "");
    }
  }

  const name = idleSlideName(idle, logoStamp);
  const dir = join(config.dataDir, "idle");
  const path = join(dir, name);
  if (existsSync(path)) return { name, path };

  const pending = inFlight.get(name);
  if (pending) return pending;

  const job = (async (): Promise<IdleSlide | null> => {
    try {
      await renderNotice(
        { headline: idle.headline, body: idle.message, footnote: "" },
        dir,
        {
          theme: idle.theme,
          logoFraction: logoPath ? 0.28 : 0,
          logoPath,
          outputName: name,
        }
      );
      return { name, path };
    } catch {
      // The player's own idle overlay is the fallback; never let this throw
      // into a plan request.
      return null;
    } finally {
      inFlight.delete(name);
    }
  })();
  inFlight.set(name, job);
  return job;
}
