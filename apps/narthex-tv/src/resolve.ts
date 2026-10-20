import { Pool } from "pg";
import { Resolution, resolveSchedule, scheduleCoverage } from "./schedule";
import { listEntries } from "./schedule-repo";
import { getPlaylist, listItems, PlaylistRow } from "./playlists";
import { AppSettings, getSamsung, loadSettings } from "./settings";
import { buildFrames, Frame, Plan, PlanItem, planRevision, PlanSource, sourceKeyFor } from "./plan";
import { localDateKey } from "./tz";
import { getTakeover, NO_TAKEOVER, Takeover, takeoverImageName } from "./takeover";
import { getPlayNow, NO_PLAY_NOW, PlayNow } from "./play-now";
import { getMedia } from "./media";
import { desiredPower } from "./power";

export type { PlanSource } from "./plan";

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
  /**
   * The playlist on screen. When `nothingPlayable`, the winning entry's
   * playlist instead, so the admin screen can say which one is empty.
   */
  playlist: PlaylistRow | null;
  source: PlanSource;
  settings: AppSettings;
  /** Whether the TV should be on at all, and when the schedule next flips that. */
  power: { on: boolean; changesAt: Date | null };
  playNow: PlayNow;
  takeover: Takeover;
  /** Something is scheduled, but no covering playlist has anything to show. */
  nothingPlayable: boolean;
  frames: Frame[];
}

async function framesForPlaylist(
  pool: Pool,
  playlist: PlaylistRow,
  seedStart: Date | null,
  settings: AppSettings,
  at: Date
): Promise<Frame[]> {
  const items: PlanItem[] = (await listItems(pool, playlist.id)).map((row) => ({
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
  }));

  // The seed is the airing, not the moment: a shuffled playlist keeps one order
  // for as long as this schedule entry holds the screen.
  const seed = (playlist.id * 2654435761 + (seedStart ? seedStart.getTime() / 1000 : 0)) >>> 0;

  return buildFrames(
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
    localDateKey(at, settings.timezone)
  );
}

/** One media item on its own, looping, at the app's default timings. */
async function framesForPlayNow(pool: Pool, playNow: PlayNow, settings: AppSettings, at: Date): Promise<Frame[]> {
  const media = await getMedia(pool, playNow.mediaId);
  if (!media) return [];
  return buildFrames(
    [{
      media: {
        id: Number(media.id),
        kind: media.kind,
        title: media.title,
        status: media.status,
        pageCount: Number(media.page_count ?? 0),
        durationMs: media.duration_ms === null ? null : Number(media.duration_ms),
      },
      seconds: 0,
      fit: "",
      enabled: true,
      showFrom: null,
      showUntil: null,
    }],
    {
      id: 0, name: media.title, imageSeconds: 0, slideSeconds: 0,
      transition: "", fit: "", footerText: "", shuffle: false,
    },
    settings,
    0,
    localDateKey(at, settings.timezone)
  );
}

/**
 * What belongs on the screen at `at`, and why. Used by the player, by the
 * "on now" card in the admin UI, and by the what-if preview -- one answer, so
 * the preview can never disagree with the TV.
 *
 * Precedence: emergency takeover > Play now > the schedule > nothing (off).
 * Play now and the takeover have no end, so they are layered on only when
 * `live` -- a preview of next Sunday shows what the schedule will do.
 */
export async function resolveNow(
  pool: Pool,
  at: Date,
  opts: { live?: boolean } = {}
): Promise<NowPlaying> {
  const settings = await loadSettings(pool);
  const entries = await listEntries(pool);
  const resolution = resolveSchedule(entries, at, settings.timezone);
  const coverage = scheduleCoverage(entries, at, settings.timezone);

  let playlist: PlaylistRow | null = null;
  let frames: Frame[] = [];
  let source: PlanSource = "none";
  let nothingPlayable = false;

  // The winner first; if its playlist was archived or has nothing to show,
  // the next entry covering this moment gets the screen.
  let firstLive: PlaylistRow | null = null;
  for (const entry of resolution.candidates) {
    const candidate = await getPlaylist(pool, entry.playlistId);
    if (!candidate || candidate.archived) continue;
    firstLive = firstLive ?? candidate;
    const startedAt = entry.id === resolution.entry?.id ? resolution.startedAt : null;
    const built = await framesForPlaylist(pool, candidate, startedAt, settings, at);
    if (built.length) {
      playlist = candidate;
      frames = built;
      source = "schedule";
      break;
    }
  }
  if (source === "none" && resolution.candidates.length) {
    // Scheduled, but nothing to show. The TV still comes on -- power follows
    // the schedule -- and the screen is black until somebody fixes the
    // playlist; the admin screen says so loudly.
    playlist = firstLive;
    nothingPlayable = true;
  }

  const playNow = opts.live ? await getPlayNow(pool) : NO_PLAY_NOW;
  const takeover = opts.live ? await getTakeover(pool) : NO_TAKEOVER;

  if (playNow.active) {
    const built = await framesForPlayNow(pool, playNow, settings, at);
    if (built.length) {
      frames = built;
      source = "play_now";
      nothingPlayable = false;
    }
  }
  if (takeover.active) source = "takeover";

  const power = {
    on: desiredPower(coverage.on, playNow.active, takeover.active) === "on",
    changesAt: coverage.changesAt,
  };

  return { resolution, playlist, source, settings, power, playNow, takeover, nothingPlayable, frames };
}

export async function buildPlan(
  pool: Pool,
  opts: { at: Date; rotation: number }
): Promise<Plan> {
  const now = await resolveNow(pool, opts.at, { live: true });
  const { resolution, playlist, source, settings, power, playNow, takeover } = now;
  const samsung = await getSamsung(pool);

  // playout.py, which feeds the narthex screen through the Blackmagic card,
  // only decodes pictures and video -- it cannot draw text. So during a
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

  const showingPlaylist = source === "schedule" ? playlist : null;
  const transition =
    showingPlaylist && (showingPlaylist.transition === "none" || showingPlaylist.transition === "fade")
      ? showingPlaylist.transition
      : settings.transition;

  const skeleton = {
    sourceKey: sourceKeyFor({
      takeoverStartedAt: takeover.active ? takeover.startedAt : null,
      playNow: playNow.active ? { mediaId: playNow.mediaId, startedAt: playNow.startedAt ?? "" } : null,
      powerOn: power.on,
      source,
      entryId: resolution.entry?.id ?? 0,
      playlistId: playlist?.id ?? 0,
      startedAt: resolution.startedAt ? resolution.startedAt.toISOString() : "",
    }),
    playlistId: showingPlaylist ? Number(showingPlaylist.id) : null,
    playlistName: source === "play_now" ? playNow.title : showingPlaylist?.name ?? "",
    entryId: resolution.entry?.id ?? null,
    entryLabel: resolution.entry?.label ?? "",
    endsAt: resolution.endsAt ? resolution.endsAt.toISOString() : null,
    display: {
      background: settings.background,
      transition,
      transitionMs: settings.transitionMs,
      clock: settings.clock,
      clockPosition: settings.clockPosition,
      timezone: settings.timezone,
      footerText: showingPlaylist?.footer_text || settings.footerText,
      rotation: opts.rotation,
      pollSeconds: settings.pollSeconds,
      loopSingleVideo: settings.videoLoopSingle,
    },
    takeover: {
      active: takeover.active,
      headline: takeover.headline,
      body: takeover.body,
      urgent: takeover.urgent,
    },
    power: {
      wakeMac: samsung.mac,
      on: power.on,
      changesAt: power.changesAt ? power.changesAt.toISOString() : null,
    },
    // An active takeover with no rendered slide yields NO frames on purpose:
    // black is better than leaving the normal loop running during an
    // emergency, and the browser player still shows the text. Nothing
    // playable is black too: there is no idle screen any more.
    frames: takeover.active ? takeoverFrames : now.frames,
  };

  return {
    ...skeleton,
    revision: planRevision(skeleton),
    serverTime: opts.at.toISOString(),
    changesAt: resolution.changesAt ? resolution.changesAt.toISOString() : null,
  };
}
