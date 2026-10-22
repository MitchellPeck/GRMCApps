// A podcast episode's audio, fetched from Buzzsprout and transcribed the same
// way as an uploaded video (one recording row per episode, the same queue), so
// podcast posts draft from what was said and not only from the show notes.
// Each episode is transcribed once; every post about it reuses the transcript.
import { Pool } from "pg";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { finishRecording, recordingPart, sermonDir } from "./sermon-files";
import { SermonOpts, SermonRow, TYPES, enqueueSermon, getSermon } from "./sermons";

// A download that hasn't moved on in this long was cut off (a restart, say) and is started again.
const STALE_DOWNLOAD_MINUTES = 15;

export interface EpisodeAudio { id: string | number; title: string; audioUrl: string }

/**
 * The episode's recording, starting the download and transcription if it
 * hasn't been, or if the last try was cut off. `retry` starts over whatever
 * state it's in (a failed transcription, or an episode re-uploaded to Buzzsprout).
 * The download runs in the background unless `wait` is set.
 */
export async function startEpisodeTranscript(
  db: Pool, ep: EpisodeAudio, opts: SermonOpts, o: { retry?: boolean; wait?: boolean; enqueue?: boolean } = {},
): Promise<SermonRow> {
  const episodeId = String(ep.id);
  const found = (await db.query(
    `SELECT id, status, updated_at < now() - make_interval(mins => $2::int) AS stale FROM sermons WHERE episode_id = $1`,
    [episodeId, STALE_DOWNLOAD_MINUTES])).rows[0];
  const busy = found && (found.status === "queued" || found.status === "transcribing" || (found.status === "uploading" && !found.stale));
  if (found && !o.retry && (busy || found.status === "ready" || found.status === "error")) return (await getSermon(db, found.id))!;
  if (found && o.retry && busy) return (await getSermon(db, found.id))!;

  const title = ep.title || `Episode ${episodeId}`;
  const id: string = found
    ? (await db.query(
        `UPDATE sermons SET status = 'uploading', progress = 'downloading from Buzzsprout', error = '', transcript = '',
                title = $2, updated_at = now() WHERE id = $1 RETURNING id`, [found.id, title])).rows[0].id
    : (await db.query(
        `INSERT INTO sermons (title, file_name, size, mime, status, progress, created_by, episode_id)
         VALUES ($1, $2, 0, 'audio/mpeg', 'uploading', 'downloading from Buzzsprout', 'buzzsprout', $3) RETURNING id`,
        [title, `episode-${episodeId}.mp3`, episodeId])).rows[0].id;

  const run = downloadAudio(db, id, ep.audioUrl, opts, o.enqueue !== false)
    .catch((e) => db.query("UPDATE sermons SET status = 'error', progress = '', error = $2, updated_at = now() WHERE id = $1",
      [id, "Couldn't download the episode from Buzzsprout: " + (e as Error).message]));
  if (o.wait) await run;
  return (await getSermon(db, id))!;
}

async function downloadAudio(db: Pool, id: string, url: string, opts: SermonOpts, enqueue: boolean): Promise<void> {
  const dir = sermonDir(opts.dataDir, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const res = await fetch(url, { headers: { "User-Agent": "GRMCApps social-posts" } });
  if (!res.ok || !res.body) throw new Error(`Buzzsprout answered ${res.status}.`);
  // Buzzsprout serves MP3; anything unrecognised is read as MP3 too, which ffmpeg copes with.
  const served = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const mime = TYPES[served] ? served : "audio/mpeg";
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(recordingPart(dir)));
  const size = (await stat(recordingPart(dir))).size;
  if (!size) throw new Error("the audio file was empty.");
  await finishRecording(dir, TYPES[mime]);
  await db.query(
    "UPDATE sermons SET size = $2, mime = $3, status = 'queued', progress = 'waiting its turn', updated_at = now() WHERE id = $1",
    [id, size, mime]);
  if (enqueue) enqueueSermon(db, id, opts);
}
