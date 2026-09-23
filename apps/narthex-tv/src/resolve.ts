import { Pool } from "pg";
import { Resolution, resolveSchedule } from "./schedule";
import { listEntries } from "./schedule-repo";
import { getPlaylist, listItems, PlaylistRow } from "./playlists";
import { AppSettings, getDefaultPlaylistId, loadSettings } from "./settings";
import { buildFrames, Plan, PlanItem, planRevision } from "./plan";
import { resolvePower } from "./power";
import { listWindows } from "./hours";

export type PlanSource = "schedule" | "default" | "none";

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
        seed
      )
    : [];

  const transition =
    playlist && (playlist.transition === "none" || playlist.transition === "fade")
      ? playlist.transition
      : settings.transition;

  const skeleton = {
    // sourceKey changes the moment a different entry (or the fallback) takes
    // over, which is how the player knows to cut immediately instead of waiting
    // for the current slide to finish.
    sourceKey: `${power.on ? "awake" : "dark"}:${source}:${resolution.entry?.id ?? 0}:${
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
      idleMessage: settings.idleMessage,
      loopSingleVideo: settings.videoLoopSingle,
    },
    power: {
      on: power.on,
      changesAt: power.changesAt ? power.changesAt.toISOString() : null,
    },
    frames,
  };

  return {
    ...skeleton,
    revision: planRevision(skeleton),
    serverTime: opts.at.toISOString(),
    changesAt: resolution.changesAt ? resolution.changesAt.toISOString() : null,
  };
}
