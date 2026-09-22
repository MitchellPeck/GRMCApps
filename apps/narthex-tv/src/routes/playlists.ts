import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { requirePermission } from "../guard";
import {
  addItems, createPlaylist, deletePlaylist, getPlaylist, listItems, listPlaylists,
  removeItem, reorderItems, updateItem, updatePlaylist, PlaylistRow, PlaylistItemRow,
} from "../playlists";
import { getDefaultPlaylistId } from "../settings";

const intParam = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

const seconds = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!isFinite(n)) return undefined;
  return Math.min(3600, Math.max(0, Math.round(n)));
};

const inheritable = (value: unknown, allowed: string[]): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const v = String(value);
  return v === "" || allowed.includes(v) ? v : undefined;
};

function playlistView(row: PlaylistRow, itemCount = 0, defaultId: number | null = null) {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    imageSeconds: row.image_seconds,
    slideSeconds: row.slide_seconds,
    transition: row.transition,
    fit: row.fit,
    shuffle: row.shuffle,
    footerText: row.footer_text,
    archived: row.archived,
    itemCount,
    isDefault: defaultId === Number(row.id),
    createdBy: row.created_by_email,
  };
}

function itemView(row: PlaylistItemRow) {
  return {
    id: Number(row.id),
    mediaId: Number(row.media_id),
    idx: row.idx,
    seconds: row.seconds,
    fit: row.fit,
    enabled: row.enabled,
    note: row.note,
    kind: row.kind,
    title: row.title,
    status: row.status,
    pageCount: Number(row.page_count ?? 0),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  };
}

export async function playlistRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/playlists", async (req) => {
    const includeArchived = String((req.query as { archived?: string }).archived ?? "") === "1";
    const rows = await listPlaylists(pool, includeArchived);
    const defaultId = await getDefaultPlaylistId(pool);
    const counts = await pool.query<{ playlist_id: number; n: number }>(
      "SELECT playlist_id, count(*)::int AS n FROM playlist_items GROUP BY playlist_id"
    );
    const byId = new Map(counts.rows.map((r) => [Number(r.playlist_id), Number(r.n)]));
    return {
      ok: true,
      playlists: rows.map((r) => playlistView(r, byId.get(Number(r.id)) ?? 0, defaultId)),
    };
  });

  app.get("/api/playlists/:id", async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const row = await getPlaylist(pool, id);
    if (!row) return reply.code(404).send({ ok: false, error: "No such playlist." });
    const items = await listItems(pool, id);
    const defaultId = await getDefaultPlaylistId(pool);
    return {
      ok: true,
      playlist: playlistView(row, items.length, defaultId),
      items: items.map(itemView),
    };
  });

  app.post("/api/playlists", { preHandler: requirePermission("schedule") }, async (req, reply) => {
    const body = req.body as { name?: string; description?: string };
    const name = String(body?.name ?? "").trim();
    if (!name) return reply.code(400).send({ ok: false, error: "Give the playlist a name." });
    const row = await createPlaylist(pool, {
      name,
      description: body?.description ?? "",
      createdByEmail: getIdentity(req).email,
    });
    return { ok: true, playlist: playlistView(row) };
  });

  app.patch("/api/playlists/:id", { preHandler: requirePermission("schedule") }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const row = await getPlaylist(pool, id);
    if (!row) return reply.code(404).send({ ok: false, error: "No such playlist." });
    const b = req.body as Record<string, unknown>;
    await updatePlaylist(pool, id, {
      name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined,
      description: typeof b.description === "string" ? b.description : undefined,
      imageSeconds: seconds(b.imageSeconds),
      slideSeconds: seconds(b.slideSeconds),
      transition: inheritable(b.transition, ["none", "fade"]),
      fit: inheritable(b.fit, ["contain", "cover"]),
      shuffle: typeof b.shuffle === "boolean" ? b.shuffle : undefined,
      footerText: typeof b.footerText === "string" ? b.footerText : undefined,
      archived: typeof b.archived === "boolean" ? b.archived : undefined,
    });
    const updated = await getPlaylist(pool, id);
    return { ok: true, playlist: playlistView(updated!) };
  });

  app.delete("/api/playlists/:id", { preHandler: requirePermission("manage") }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const used = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM schedule_entries WHERE playlist_id = $1",
      [id]
    );
    const force = String((req.query as { force?: string }).force ?? "") === "1";
    if (Number(used.rows[0]?.n ?? 0) > 0 && !force) {
      return reply.code(409).send({
        ok: false,
        error: "That playlist is still scheduled. Deleting it removes those schedule entries too.",
      });
    }
    const gone = await deletePlaylist(pool, id);
    if (!gone) return reply.code(404).send({ ok: false, error: "No such playlist." });
    return { ok: true };
  });

  // ── items ────────────────────────────────────────────────────────────────

  app.post("/api/playlists/:id/items", { preHandler: requirePermission("schedule") }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    if (!(await getPlaylist(pool, id))) {
      return reply.code(404).send({ ok: false, error: "No such playlist." });
    }
    const body = req.body as { mediaIds?: unknown };
    const ids = Array.isArray(body?.mediaIds) ? body.mediaIds.map(intParam).filter(Boolean) : [];
    if (!ids.length) return reply.code(400).send({ ok: false, error: "Pick something to add." });
    const added = await addItems(pool, id, ids);
    return { ok: true, added, items: (await listItems(pool, id)).map(itemView) };
  });

  app.patch("/api/playlists/:id/items/:itemId", { preHandler: requirePermission("schedule") }, async (req) => {
    const params = req.params as { id: string; itemId: string };
    const b = req.body as Record<string, unknown>;
    await updateItem(pool, intParam(params.itemId), {
      seconds: seconds(b.seconds),
      fit: inheritable(b.fit, ["contain", "cover"]),
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
      note: typeof b.note === "string" ? b.note : undefined,
    });
    return { ok: true, items: (await listItems(pool, intParam(params.id))).map(itemView) };
  });

  app.delete("/api/playlists/:id/items/:itemId", { preHandler: requirePermission("schedule") }, async (req) => {
    const params = req.params as { id: string; itemId: string };
    await removeItem(pool, intParam(params.itemId));
    return { ok: true, items: (await listItems(pool, intParam(params.id))).map(itemView) };
  });

  app.post("/api/playlists/:id/reorder", { preHandler: requirePermission("schedule") }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const body = req.body as { itemIds?: unknown };
    const ids = Array.isArray(body?.itemIds) ? body.itemIds.map(intParam).filter(Boolean) : [];
    if (!ids.length) return reply.code(400).send({ ok: false, error: "Nothing to reorder." });
    await reorderItems(pool, id, ids);
    return { ok: true, items: (await listItems(pool, id)).map(itemView) };
  });
}
