import { Pool } from "pg";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { MediaKind } from "./ingest";

export interface MediaRow {
  id: number;
  kind: MediaKind;
  title: string;
  file_name: string;
  mime_type: string;
  byte_size: string | number;
  status: "pending" | "processing" | "ready" | "failed";
  error: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  page_count: number;
  original_path: string;
  play_path: string;
  poster_path: string;
  uploaded_by_email: string;
  uploaded_by_name: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, kind, title, file_name, mime_type, byte_size, status, error,
                 width, height, duration_ms, page_count, original_path, play_path,
                 poster_path, uploaded_by_email, uploaded_by_name, created_at, updated_at`;

/** Every artefact for one upload lives under one directory, so deleting the
 *  row and deleting the bytes are the same one-line operation. */
export function mediaDir(id: number): string {
  return join(config.dataDir, "media", String(id));
}

export async function createMedia(
  pool: Pool,
  fields: {
    kind: MediaKind;
    title: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    uploadedByEmail: string;
    uploadedByName: string;
  }
): Promise<MediaRow> {
  const r = await pool.query<MediaRow>(
    `INSERT INTO media (kind, title, file_name, mime_type, byte_size,
                        uploaded_by_email, uploaded_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      fields.kind,
      fields.title,
      fields.fileName,
      fields.mimeType,
      fields.byteSize,
      fields.uploadedByEmail,
      fields.uploadedByName,
    ]
  );
  return r.rows[0];
}

export async function getMedia(pool: Pool, id: number): Promise<MediaRow | null> {
  const r = await pool.query<MediaRow>(`SELECT ${COLUMNS} FROM media WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function listMedia(pool: Pool): Promise<MediaRow[]> {
  const r = await pool.query<MediaRow>(`SELECT ${COLUMNS} FROM media ORDER BY id DESC`);
  return r.rows;
}

export async function setMediaPaths(
  pool: Pool,
  id: number,
  fields: {
    originalPath?: string;
    playPath?: string;
    posterPath?: string;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    pageCount?: number;
  }
): Promise<void> {
  await pool.query(
    `UPDATE media SET
       original_path = COALESCE($2, original_path),
       play_path     = COALESCE($3, play_path),
       poster_path   = COALESCE($4, poster_path),
       width         = COALESCE($5, width),
       height        = COALESCE($6, height),
       duration_ms   = COALESCE($7, duration_ms),
       page_count    = COALESCE($8, page_count),
       updated_at    = now()
     WHERE id = $1`,
    [
      id,
      fields.originalPath ?? null,
      fields.playPath ?? null,
      fields.posterPath ?? null,
      fields.width ?? null,
      fields.height ?? null,
      fields.durationMs ?? null,
      fields.pageCount ?? null,
    ]
  );
}

export async function setMediaStatus(
  pool: Pool,
  id: number,
  status: MediaRow["status"],
  error = ""
): Promise<void> {
  await pool.query(
    "UPDATE media SET status = $2, error = $3, updated_at = now() WHERE id = $1",
    [id, status, error.slice(0, 500)]
  );
}

export async function renameMedia(pool: Pool, id: number, title: string): Promise<void> {
  await pool.query("UPDATE media SET title = $2, updated_at = now() WHERE id = $1", [
    id,
    title.slice(0, 200),
  ]);
}

export async function replacePages(pool: Pool, id: number, paths: string[]): Promise<void> {
  await pool.query("DELETE FROM media_pages WHERE media_id = $1", [id]);
  for (let i = 0; i < paths.length; i++) {
    await pool.query("INSERT INTO media_pages (media_id, idx, path) VALUES ($1, $2, $3)", [
      id,
      i + 1,
      paths[i],
    ]);
  }
  await pool.query("UPDATE media SET page_count = $2, updated_at = now() WHERE id = $1", [
    id,
    paths.length,
  ]);
}

export async function getPagePath(pool: Pool, id: number, idx: number): Promise<string | null> {
  const r = await pool.query<{ path: string }>(
    "SELECT path FROM media_pages WHERE media_id = $1 AND idx = $2",
    [id, idx]
  );
  return r.rows[0]?.path ?? null;
}

export interface MediaUsage {
  playlistId: number;
  playlistName: string;
}

/** Which playlists would lose an item if this were deleted. */
export async function mediaUsage(pool: Pool, id: number): Promise<MediaUsage[]> {
  const r = await pool.query<{ playlistId: number; playlistName: string }>(
    `SELECT DISTINCT p.id AS "playlistId", p.name AS "playlistName"
       FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
      WHERE i.media_id = $1 AND p.archived = false
      ORDER BY 2`,
    [id]
  );
  return r.rows;
}

export async function deleteMedia(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM media WHERE id = $1 RETURNING id", [id]);
  // Bytes go after the row: an orphaned directory is recoverable housekeeping,
  // a row pointing at files that are gone is a broken screen.
  await rm(mediaDir(id), { recursive: true, force: true }).catch(() => {});
  return r.rowCount !== null && r.rowCount > 0;
}

/** Anything left mid-flight by a restart, so the queue can pick it back up. */
export async function listUnfinished(pool: Pool): Promise<MediaRow[]> {
  const r = await pool.query<MediaRow>(
    `SELECT ${COLUMNS} FROM media WHERE status IN ('pending', 'processing') ORDER BY id`
  );
  return r.rows;
}
