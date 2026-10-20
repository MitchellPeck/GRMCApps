import { Pool } from "pg";
import { Resolution, resolveSchedule, ScheduleEntry, scheduleCoverage } from "./schedule";
import { choosePlaying } from "./choose";
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
  /** The schedule entry on screen (or, when nothing is playable, named). */
  entry: ScheduleEntry | null;
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

  // Every covering entry, best first, with what it would show. The first
  // that can actually show something plays.
  const covering = [];
  for (const entry of resolution.candidates) {
    const candidate = await getPlaylist(pool, entry.playlistId);
    const startedAt = entry.id === resolution.entry?.id ? resolution.startedAt : null;
    const frames =
      candidate && !candidate.archived
        ? await framesForPlaylist(pool, candidate, startedAt, settings, at)
        : [];
    covering.push({ entry, playlist: candidate, frames, frameCount: frames.length });
  }
  const choice = choosePlaying(covering);

  const shown = choice.named === null ? null : covering[choice.named];
  // The entry actually on screen -- not necessarily the winner, whose
  // playlist may be empty -- or, when nothing is playable, the one whose
  // playlist the admin screen names.
  const entry: ScheduleEntry | null = shown?.entry ?? null;
  const playlist: PlaylistRow | null = shown?.playlist ?? null;
  let frames: Frame[] = choice.playing === null ? [] : covering[choice.playing].frames;
  let source: PlanSource = choice.playing === null ? "none" : "schedule";
  let nothingPlayable = choice.nothingPlayable;

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

  return { resolution, entry, playlist, source, settings, power, playNow, takeover, nothingPlayable, frames };
}

export async function buildPlan(
  pool: Pool,
  opts: { at: Date; rotation: number }
): Promise<Plan> {
  const now = await resolveNow(pool, opts.at, { live: true });
  const { resolution, entry, playlist, source, settings, power, playNow, takeover } = now;
  // Its own start and end are known only when it is the winner; a fallback
  // entry borrowed the screen and the plan does not need them to cut.
  const isWinner = entry !== null && entry.id === resolution.entry?.id;
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
      entryId: entry?.id ?? 0,
      playlistId: playlist?.id ?? 0,
      startedAt: isWinner && resolution.startedAt ? resolution.startedAt.toISOString() : "",
    }),
    playlistId: showingPlaylist ? Number(showingPlaylist.id) : null,
    playlistName: source === "play_now" ? playNow.title : showingPlaylist?.name ?? "",
    entryId: entry?.id ?? null,
    entryLabel: entry?.label ?? "",
    endsAt: isWinner && resolution.endsAt ? resolution.endsAt.toISOString() : null,
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
