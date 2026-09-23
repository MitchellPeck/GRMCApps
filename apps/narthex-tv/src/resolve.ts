import { Pool } from "pg";
import { Resolution, resolveSchedule } from "./schedule";
import { listEntries } from "./schedule-repo";
import { getPlaylist, listItems, PlaylistRow } from "./playlists";
import { AppSettings, getDefaultPlaylistId, loadSettings } from "./settings";
import { buildFrames, Frame, Plan, PlanItem, planRevision } from "./plan";
import { resolvePower } from "./power";
import { localDateKey } from "./tz";
import { listWindows } from "./hours";
import { getTakeover, takeoverImageName } from "./takeover";
import { ensureIdleSlide, loadIdle } from "./idle";

export type PlanSource = "schedule" | "default" | "none";

// pg hands back a `date` column as a Date at LOCAL midnight, so the key has to
// come from its local parts rather than toISOString(), which would shift it a
// day west of Greenwich.
function dateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate()
  ).padStart(2, "0")}`;
}

export interface NowPlaying {
  resolution: Resolution;
  playlist: PlaylistRow | null;
  source: PlanSource;
  settings: AppSettings;
  /** Whether the narthex is inside its operating hours at all. */
  power: { on: boolean; changesAt: Date | null };
}

/**
 * What belongs on the screen at `at`, and why. Used by the player, by the
 * "on now" card in the admin UI, and by the what-if preview — one answer, so
 * the preview can never disagree with the TV.
 */
export async function resolveNow(pool: Pool, at: Date): Promise<NowPlaying> {
  const settings = await loadSettings(pool);
  const entries = await listEntries(pool);
  const resolution = resolveSchedule(entries, at, settings.timezone);

  // Operating hours are orthogonal to the schedule: they decide whether there
  // is a picture at all, not which picture. Resolved here so the admin UI and
  // the TV agree about a dark screen the same way they agree about a playlist.
  const power = resolvePower(
    settings.hoursMode,
    await listWindows(pool),
    at,
    settings.timezone
  );

  if (resolution.entry) {
    const playlist = await getPlaylist(pool, resolution.entry.playlistId);
    if (playlist && !playlist.archived) {
      return { resolution, playlist, source: "schedule", settings, power };
    }
  }

  // Nothing scheduled (or the scheduled playlist was archived out from under
  // it): fall back to the standing default so the narthex is never a black
  // rectangle by accident.
  const defaultId = await getDefaultPlaylistId(pool);
  const fallback = defaultId ? await getPlaylist(pool, defaultId) : null;
  if (fallback && !fallback.archived) {
    return { resolution, playlist: fallback, source: "default", settings, power };
  }
  return { resolution, playlist: null, source: "none", settings, power };
}

export async function buildPlan(
  pool: Pool,
  opts: { at: Date; rotation: number }
): Promise<Plan> {
  const { resolution, playlist, source, settings, power } = await resolveNow(pool, opts.at);
  const takeover = await getTakeover(pool);

  const items: PlanItem[] = playlist
    ? (await listItems(pool, playlist.id)).map((row) => ({
        media: {
          id: Number(row.media_id),
          kind: row.kind,
          title: row.title,
          status: row.status,
          pageCount: Number(row.page_count ?? 0),
          durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        },
        seconds: Number(row.seconds ?? 0),
        fit: row.fit ?? "",
        enabled: row.enabled,
        showFrom: dateKey(row.show_from),
        showUntil: dateKey(row.show_until),
      }))
    : [];

  // The seed is the airing, not the moment: a shuffled playlist keeps one order
  // for as long as this schedule entry holds the screen.
  const seed = playlist
    ? (playlist.id * 2654435761 + (resolution.startedAt ? resolution.startedAt.getTime() / 1000 : 0)) >>> 0
    : 0;

  const frames = playlist
    ? buildFrames(
        items,
        {
          id: playlist.id,
          name: playlist.name,
          imageSeconds: playlist.image_seconds,
          slideSeconds: playlist.slide_seconds,
          transition: playlist.transition,
          fit: playlist.fit,
          footerText: playlist.footer_text,
          shuffle: playlist.shuffle,
        },
        settings,
        seed,
        localDateKey(opts.at, settings.timezone)
      )
    : [];

  // playout.py, which feeds the narthex screen through the Blackmagic card,
  // only decodes pictures and video — it cannot draw text. So during a
  // takeover the plan's frames ARE the takeover, rendered. Without this the
  // emergency shows in a browser and the actual screen carries on with last
  // week's announcements. The browser player ignores frames while a takeover
  // is up and draws the text itself, which scales better.
  const takeoverFrames: Frame[] =
    takeover.active && takeover.imagePath && takeover.startedAt
      ? [{
          kind: "image" as const,
          url: `/api/player/takeover/${takeoverImageName(takeover.startedAt)}`,
          ms: 30_000,
          fit: "contain" as const,
          mediaId: 0,
          page: 0,
          title: takeover.headline || "Emergency message",
        }]
      : [];

  // Nothing to show: fall back to the configured idle screen, rendered, so
  // the wall shows it too. playout.py cannot draw text — an idle screen that
  // lived only in the browser would leave the actual screen black.
  const idle = await loadIdle(pool);
  let idleFrames: Frame[] = [];
  if (!takeover.active && frames.length === 0 && power.on) {
    const slide = await ensureIdleSlide(pool);
    if (slide) {
      idleFrames = [{
        kind: "image" as const,
        url: `/api/player/idle/${slide.name}`,
        ms: 60_000,
        fit: "contain" as const,
        mediaId: 0,
        page: 0,
        title: "Idle screen",
      }];
    }
  }

  const transition =
    playlist && (playlist.transition === "none" || playlist.transition === "fade")
      ? playlist.transition
      : settings.transition;

  const skeleton = {
    // sourceKey changes the moment a different entry (or the fallback) takes
    // over, which is how the player knows to cut immediately instead of waiting
    // for the current slide to finish.
    // The takeover is in the sourceKey so it cuts in at once rather than
    // waiting out the current slide, and out again the moment it is cleared.
    sourceKey: `${takeover.active ? "TAKEOVER:" + takeover.startedAt : ""}${power.on ? "awake" : "dark"}:${source}:${resolution.entry?.id ?? 0}:${
      playlist?.id ?? 0
    }:${resolution.startedAt ? resolution.startedAt.toISOString() : ""}`,
    playlistId: playlist ? Number(playlist.id) : null,
    playlistName: playlist?.name ?? "",
    entryId: resolution.entry?.id ?? null,
    entryLabel: resolution.entry?.label ?? "",
    endsAt: resolution.endsAt ? resolution.endsAt.toISOString() : null,
    display: {
      background: settings.background,
      transition,
      transitionMs: settings.transitionMs,
      clock: settings.clock,
      clockPosition: settings.clockPosition,
      footerText: playlist?.footer_text || settings.footerText,
      rotation: opts.rotation,
      pollSeconds: settings.pollSeconds,
      idleMessage: idle.message || settings.idleMessage,
      idleHeadline: idle.headline,
      idleShowMark: idle.showMark && !idle.logoMediaId,
      loopSingleVideo: settings.videoLoopSingle,
    },
    takeover: {
      active: takeover.active,
      headline: takeover.headline,
      body: takeover.body,
      urgent: takeover.urgent,
    },
    power: {
      // A takeover overrides the operating hours outright: a dark screen is no
      // use to somebody being told to evacuate.
      on: power.on || takeover.active,
      changesAt: power.changesAt ? power.changesAt.toISOString() : null,
    },
    // An active takeover with no rendered slide yields NO frames on purpose:
    // black is better than leaving the normal loop running during an
    // emergency, and the browser player still shows the text.
    frames: takeover.active ? takeoverFrames : (frames.length ? frames : idleFrames),
  };

  return {
    ...skeleton,
    revision: planRevision(skeleton),
    serverTime: opts.at.toISOString(),
    changesAt: resolution.changesAt ? resolution.changesAt.toISOString() : null,
  };
}
