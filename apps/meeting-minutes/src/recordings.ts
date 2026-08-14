import { Pool } from "pg";
import { mkdir, writeFile, unlink, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config";

export interface Recording {
  id: number;
  item_id: number;
  file_name: string;
  mime_type: string;
  byte_size: number;
  storage_path: string;
}

// Extensions we are willing to write to disk. Anything else becomes "webm",
// so a hostile upload filename can never influence the path we open.
const KNOWN_EXTENSIONS = ["mp3", "mp4", "m4a", "wav", "webm", "ogg", "oga", "mpeg", "mpga", "flac"];

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/mp4": "m4a",
  "video/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
};

export function extensionFor(fileName: string, mimeType: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  const fromName = m ? m[1].toLowerCase() : "";
  if (KNOWN_EXTENSIONS.includes(fromName)) return fromName;
  const fromMime = MIME_EXTENSIONS[mimeType.trim().toLowerCase().split(";")[0]];
  return fromMime ?? "webm";
}

export function recordingPath(root: string, itemId: number, recordingId: number, ext: string): string {
  return join(root, "audio", String(itemId), `${recordingId}.${ext}`);
}

function rowToRecording(row: any): Recording {
  return {
    id: Number(row.id),
    item_id: Number(row.item_id),
    file_name: row.file_name,
    mime_type: row.mime_type,
    byte_size: Number(row.byte_size),
    storage_path: row.storage_path,
  };
}

// Write an uploaded recording to the data volume and record it. The row is
// inserted first so the filename can use its id, then updated with the final
// path. Callers must persist audio through this BEFORE queueing a job, so a
// restart can always resume from disk.
export async function saveRecording(
  pool: Pool,
  itemId: number,
  file: { fileName: string; mimeType: string; buffer: Buffer }
): Promise<Recording> {
  const inserted = await pool.query(
    `INSERT INTO item_recordings (item_id, file_name, mime_type, byte_size, storage_path)
     VALUES ($1, $2, $3, $4, '') RETURNING id`,
    [itemId, file.fileName || "recording", file.mimeType || "", file.buffer.byteLength]
  );
  const id = Number(inserted.rows[0].id);
  const path = recordingPath(config.dataDir, itemId, id, extensionFor(file.fileName, file.mimeType));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.buffer);
  const updated = await pool.query(
    "UPDATE item_recordings SET storage_path = $2 WHERE id = $1 RETURNING *",
    [id, path]
  );
  return rowToRecording(updated.rows[0]);
}

export async function getRecording(pool: Pool, recordingId: number): Promise<Recording | null> {
  const r = await pool.query("SELECT * FROM item_recordings WHERE id = $1", [recordingId]);
  return r.rows[0] ? rowToRecording(r.rows[0]) : null;
}

export async function listRecordings(pool: Pool, itemId: number): Promise<Recording[]> {
  const r = await pool.query("SELECT * FROM item_recordings WHERE item_id = $1 ORDER BY id", [itemId]);
  return r.rows.map(rowToRecording);
}

export async function latestRecording(pool: Pool, itemId: number): Promise<Recording | null> {
  const r = await pool.query(
    "SELECT * FROM item_recordings WHERE item_id = $1 ORDER BY id DESC LIMIT 1",
    [itemId]
  );
  return r.rows[0] ? rowToRecording(r.rows[0]) : null;
}

// Remove the audio files belonging to these items. Best-effort: a missing or
// undeletable file never blocks the owning delete. Called just before the DB
// rows cascade away — the only moment recordings are ever removed.
export async function removeRecordingFiles(pool: Pool, itemIds: number[]): Promise<void> {
  if (!itemIds.length) return;
  const r = await pool.query(
    "SELECT storage_path FROM item_recordings WHERE item_id = ANY($1)",
    [itemIds]
  );
  for (const row of r.rows) {
    if (row.storage_path) {
      try { await unlink(row.storage_path); } catch { /* already gone */ }
    }
  }
  for (const id of new Set(itemIds)) {
    try { await rmdir(join(config.dataDir, "audio", String(id))); } catch { /* not empty or missing */ }
  }
}
