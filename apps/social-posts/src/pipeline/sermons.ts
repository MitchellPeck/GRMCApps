// Sermon recordings: uploaded in pieces, transcribed in the background (one at
// a time), and used as a drafting source — a post's sermon is its source_ref
// { kind: "sermon", id }. The recording stays on the host's data volume,
// signed-in only; nothing here is public.
import { Pool } from "pg";
import { Readable } from "node:stream";
import { mkdir } from "node:fs/promises";
import { Result } from "./rules";
import { CHUNK_BYTES, UploadError, appendChunk, finishRecording, receivedBytes, removeSermonFiles, sermonDir } from "./sermon-files";
import { transcribeRecording } from "./sermon-transcribe";

export interface SermonOpts { dataDir: string; whisperUrl: string }
export function sermonOpts(): SermonOpts {
  return { dataDir: process.env.SOCIALPOSTS_DATA_DIR || "/data", whisperUrl: process.env.WHISPER_REST_URL || "http://whisper:9000" };
}
export const MAX_SERMON_BYTES = (Number(process.env.SOCIALPOSTS_MAX_SERMON_MB) || 4096) * 1024 * 1024;

const TYPES: Record<string, string> = {
  "video/mp4": "mp4", "video/quicktime": "mov", "video/x-m4v": "m4v", "video/webm": "webm",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav",
};

export interface SermonRow {
  id: string; title: string; fileName: string; size: number; type: string;
  status: "uploading" | "queued" | "transcribing" | "ready" | "error";
  progress: string; error: string; durationSeconds: number; transcript: string; createdAt: string;
}

function rowOf(r: any): SermonRow {
  return { id: r.id, title: r.title, fileName: r.file_name, size: Number(r.size), type: r.mime, status: r.status,
    progress: r.progress, error: r.error, durationSeconds: Number(r.duration_seconds || 0), transcript: r.transcript || "",
    createdAt: new Date(r.created_at).toISOString() };
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function durationLabel(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
}

/** Why a sermon can't be drafted from yet, for the person waiting on it. */
export function notReadyMessage(s: SermonRow): string {
  if (s.status === "uploading") return "The sermon recording hasn't finished uploading.";
  if (s.status === "error") return "The sermon couldn't be transcribed: " + s.error;
  return "The sermon is still being transcribed" + (s.progress ? ` (${s.progress})` : "") + ". Try again in a few minutes.";
}

export async function getSermon(db: Pool, id: string): Promise<SermonRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await db.query("SELECT * FROM sermons WHERE id = $1", [id]);
  return r.rowCount ? rowOf(r.rows[0]) : null;
}

export async function createSermon(
  db: Pool, f: { fileName: string; size: number; type: string }, createdBy: string, opts: SermonOpts,
): Promise<Result<SermonRow & { chunkBytes: number }>> {
  const type = String(f.type || "").toLowerCase();
  if (!TYPES[type]) return fail("Upload a video (MP4, MOV, M4V, WebM) or audio file (MP3, M4A, AAC, WAV).");
  const size = Number(f.size);
  if (!Number.isInteger(size) || size <= 0) return fail("That file is empty.");
  if (size > MAX_SERMON_BYTES) return fail(`That file is larger than ${Math.round(MAX_SERMON_BYTES / 1024 / 1024 / 1024)} GB.`);
  const fileName = String(f.fileName || "Sermon").slice(0, 200);
  const title = fileName.replace(/\.[a-z0-9]{2,4}$/i, "");
  const r = await db.query(
    `INSERT INTO sermons (title, file_name, size, mime, status, created_by) VALUES ($1,$2,$3,$4,'uploading',$5) RETURNING *`,
    [title, fileName, size, type, createdBy]);
  await mkdir(sermonDir(opts.dataDir, r.rows[0].id), { recursive: true });
  return { ok: true, value: { ...rowOf(r.rows[0]), chunkBytes: CHUNK_BYTES } };
}

export async function receiveChunk(db: Pool, id: string, offset: number, body: Readable, opts: SermonOpts): Promise<number> {
  const s = await getSermon(db, id);
  if (!s) { body.resume(); throw new UploadError(404, "That upload doesn't exist."); }
  if (s.status !== "uploading") { body.resume(); throw new UploadError(409, "That upload is already finished.", s.size); }
  return appendChunk(sermonDir(opts.dataDir, id), s.size, offset, body);
}

export async function completeSermon(
  db: Pool, id: string, opts: SermonOpts, o: { enqueue?: boolean } = {},
): Promise<Result<SermonRow>> {
  const s = await getSermon(db, id);
  if (!s) return fail("That upload doesn't exist.");
  if (s.status !== "uploading") return { ok: true, value: s };
  const have = await receivedBytes(sermonDir(opts.dataDir, id));
  if (have !== s.size) return fail(`Only ${have} of ${s.size} bytes have arrived. Keep the page open until the upload finishes.`);
  await finishRecording(sermonDir(opts.dataDir, id), TYPES[s.type]);
  await db.query("UPDATE sermons SET status = 'queued', progress = 'waiting its turn', updated_at = now() WHERE id = $1", [id]);
  if (o.enqueue !== false) enqueueSermon(db, id, opts);
  return { ok: true, value: (await getSermon(db, id))! };
}

/** Transcribe one recording, recording progress and the outcome on its row. */
export async function processSermon(db: Pool, id: string, opts: SermonOpts): Promise<void> {
  const s = await getSermon(db, id);
  if (!s || (s.status !== "queued" && s.status !== "transcribing")) return;
  const set = (fields: string, vals: unknown[]) => db.query(`UPDATE sermons SET ${fields}, updated_at = now() WHERE id = $1`, [id, ...vals]);
  await set("status = 'transcribing', progress = 'starting', error = ''", []);
  try {
    const out = await transcribeRecording(`${sermonDir(opts.dataDir, id)}/recording.${TYPES[s.type]}`, {
      whisperUrl: opts.whisperUrl,
      onProgress: async (part, of) => { await set("progress = $2", [of > 1 ? `part ${part} of ${of}` : "transcribing"]); },
    });
    if (!out.text.trim()) throw new Error("No speech was found in the recording.");
    await set("status = 'ready', progress = '', transcript = $2, segments = $3, duration_seconds = $4",
      [out.text, JSON.stringify(out.segments), out.durationSeconds]);
  } catch (e) {
    await set("status = 'error', progress = '', error = $2", [(e as Error).message]);
  }
}

// One transcription at a time: the host's CPU is shared with everything else.
let chain: Promise<void> = Promise.resolve();
export function enqueueSermon(db: Pool, id: string, opts: SermonOpts): void {
  chain = chain.then(() => processSermon(db, id, opts)).catch(() => { /* recorded on the row */ });
}

export async function retrySermon(db: Pool, id: string, opts: SermonOpts): Promise<Result<SermonRow>> {
  const s = await getSermon(db, id);
  if (!s) return fail("That recording doesn't exist.");
  if (s.status !== "error") return fail("Only a recording that failed can be retried.");
  await db.query("UPDATE sermons SET status = 'queued', progress = 'waiting its turn', error = '', updated_at = now() WHERE id = $1", [id]);
  enqueueSermon(db, id, opts);
  return { ok: true, value: (await getSermon(db, id))! };
}

/** At boot: pick unfinished transcriptions back up; drop uploads abandoned for a day. */
export async function recoverSermons(db: Pool, opts: SermonOpts): Promise<{ resumed: number; dropped: number }> {
  const pending = await db.query("UPDATE sermons SET status = 'queued' WHERE status IN ('queued','transcribing') RETURNING id");
  for (const r of pending.rows) enqueueSermon(db, r.id, opts);
  const stale = await db.query("DELETE FROM sermons WHERE status = 'uploading' AND updated_at < now() - interval '24 hours' RETURNING id");
  for (const r of stale.rows) await removeSermonFiles(opts.dataDir, r.id);
  return { resumed: pending.rowCount || 0, dropped: stale.rowCount || 0 };
}
