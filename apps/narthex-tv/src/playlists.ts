import { Pool } from "pg";
import { MediaKind } from "./ingest";

export interface PlaylistRow {
  id: number;
  name: string;
  description: string;
  image_seconds: number;
  slide_seconds: number;
  transition: string;
  fit: string;
  shuffle: boolean;
  footer_text: string;
  archived: boolean;
  created_by_email: string;
  created_at: string;
  updated_at: string;
}

export interface PlaylistItemRow {
  id: number;
  playlist_id: number;
  media_id: number;
  idx: number;
  seconds: number;
  fit: string;
  enabled: boolean;
  note: string;
  show_from: Date | string | null;
  show_until: Date | string | null;
  // joined from media
  kind: MediaKind;
  title: string;
  status: string;
  page_count: number;
  duration_ms: number | null;
  file_name: string;
}

const COLUMNS = `id, name, description, image_seconds, slide_seconds, transition, fit,
                 shuffle, footer_text, archived, created_by_email, created_at, updated_at`;

export async function listPlaylists(pool: Pool, includeArchived = false): Promise<PlaylistRow[]> {
  const r = await pool.query<PlaylistRow>(
    `SELECT ${COLUMNS} FROM playlists
      ${includeArchived ? "" : "WHERE archived = false"}
      ORDER BY archived, lower(name)`
  );
  return r.rows;
}

export async function getPlaylist(pool: Pool, id: number): Promise<PlaylistRow | null> {
  const r = await pool.query<PlaylistRow>(`SELECT ${COLUMNS} FROM playlists WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function createPlaylist(
  pool: Pool,
  fields: { name: string; description?: string; createdByEmail: string }
): Promise<PlaylistRow> {
  const r = await pool.query<PlaylistRow>(
    `INSERT INTO playlists (name, description, created_by_email)
     VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
    [fields.name.slice(0, 120), (fields.description ?? "").slice(0, 500), fields.createdByEmail]
  );
  return r.rows[0];
}

export interface PlaylistPatch {
  name?: string;
  description?: string;
  imageSeconds?: number;
  slideSeconds?: number;
  transition?: string;
  fit?: string;
  shuffle?: boolean;
  footerText?: string;
  archived?: boolean;
}

export async function updatePlaylist(pool: Pool, id: number, p: PlaylistPatch): Promise<void> {
  await pool.query(
    `UPDATE playlists SET
       name          = COALESCE($2, name),
       description   = COALESCE($3, description),
       image_seconds = COALESCE($4, image_seconds),
       slide_seconds = COALESCE($5, slide_seconds),
       transition    = COALESCE($6, transition),
       fit           = COALESCE($7, fit),
       shuffle       = COALESCE($8, shuffle),
       footer_text   = COALESCE($9, footer_text),
       archived      = COALESCE($10, archived),
       updated_at    = now()
     WHERE id = $1`,
    [
      id,
      p.name?.slice(0, 120) ?? null,
      p.description?.slice(0, 500) ?? null,
      p.imageSeconds ?? null,
      p.slideSeconds ?? null,
      p.transition ?? null,
      p.fit ?? null,
      p.shuffle ?? null,
      p.footerText?.slice(0, 300) ?? null,
      p.archived ?? null,
    ]
  );
}

export async function deletePlaylist(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM playlists WHERE id = $1 RETURNING id", [id]);
  return r.rowCount !== null && r.rowCount > 0;
}

export async function listItems(pool: Pool, playlistId: number): Promise<PlaylistItemRow[]> {
  const r = await pool.query<PlaylistItemRow>(
    `SELECT i.id, i.playlist_id, i.media_id, i.idx, i.seconds, i.fit, i.enabled, i.note,
            i.show_from, i.show_until,
            m.kind, m.title, m.status, m.page_count, m.duration_ms, m.file_name
       FROM playlist_items i JOIN media m ON m.id = i.media_id
      WHERE i.playlist_id = $1
      ORDER BY i.idx, i.id`,
    [playlistId]
  );
  return r.rows;
}

export async function addItems(
  pool: Pool,
  playlistId: number,
  mediaIds: number[]
): Promise<number> {
  const r = await pool.query<{ next: number }>(
    "SELECT COALESCE(max(idx), -1) + 1 AS next FROM playlist_items WHERE playlist_id = $1",
    [playlistId]
  );
  let idx = Number(r.rows[0]?.next ?? 0);
  let added = 0;
  for (const mediaId of mediaIds) {
    const ins = await pool.query(
      `INSERT INTO playlist_items (playlist_id, media_id, idx)
       SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM media WHERE id = $2)`,
      [playlistId, mediaId, idx]
    );
    if (ins.rowCount) { idx++; added++; }
  }
  return added;
}

export interface ItemPatch {
  seconds?: number;
  fit?: string;
  enabled?: boolean;
  note?: string;
  // undefined leaves the bound alone; null clears it.
  showFrom?: string | null;
  showUntil?: string | null;
}

export async function updateItem(pool: Pool, itemId: number, p: ItemPatch): Promise<void> {
  await pool.query(
    `UPDATE playlist_items SET
       seconds    = COALESCE($2, seconds),
       fit        = COALESCE($3, fit),
       enabled    = COALESCE($4, enabled),
       note       = COALESCE($5, note),
       -- The date bounds need an explicit "was this sent?" flag, because
       -- COALESCE cannot tell "clear this" from "leave it alone".
       show_from  = CASE WHEN $6::boolean THEN $7::date ELSE show_from END,
       show_until = CASE WHEN $8::boolean THEN $9::date ELSE show_until END
     WHERE id = $1`,
    [
      itemId, p.seconds ?? null, p.fit ?? null, p.enabled ?? null,
      p.note?.slice(0, 300) ?? null,
      p.showFrom !== undefined, p.showFrom ?? null,
      p.showUntil !== undefined, p.showUntil ?? null,
    ]
  );
}

export async function removeItem(pool: Pool, itemId: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM playlist_items WHERE id = $1 RETURNING id", [itemId]);
  return r.rowCount !== null && r.rowCount > 0;
}

/** Rewrites idx to match the order the UI just dragged things into. */
export async function reorderItems(
  pool: Pool,
  playlistId: number,
  itemIds: number[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < itemIds.length; i++) {
      await client.query(
        "UPDATE playlist_items SET idx = $3 WHERE id = $1 AND playlist_id = $2",
        [itemIds[i], playlistId, i]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
