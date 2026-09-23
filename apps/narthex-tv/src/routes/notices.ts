import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { requirePermission } from "../guard";
import { queue } from "../worker";
import { enqueueMedia } from "../queue";
import { createMedia, deleteMedia, getMedia, setMediaStatus } from "../media";
import { THEMES, validateNotice } from "../notices";
import {
  createNotice, deleteNotice, getNotice, listNotices, noticeText, NoticeRow, updateNotice,
} from "../notices-repo";

const intParam = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

const read = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    text: {
      headline: String(b.headline ?? "").trim(),
      body: String(b.body ?? "").trim(),
      footnote: String(b.footnote ?? "").trim(),
    },
    theme: Object.keys(THEMES).includes(String(b.theme)) ? String(b.theme) : "navy",
  };
};

const view = (row: NoticeRow) => ({
  id: Number(row.id),
  headline: row.headline,
  body: row.body,
  footnote: row.footnote,
  theme: row.theme,
  createdBy: row.created_by,
  mediaId: row.media_id === null ? null : Number(row.media_id),
  status: row.media_status ?? "pending",
  error: row.media_error ?? "",
});

export async function noticeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notices", async () => ({
    ok: true,
    themes: Object.keys(THEMES),
    notices: (await listNotices(pool)).map(view),
  }));

  app.post("/api/notices", { preHandler: requirePermission("upload") }, async (req, reply) => {
    const { text, theme } = read(req.body);
    const check = validateNotice(text);
    if (!check.ok) return reply.code(400).send({ ok: false, error: check.error });

    const identity = getIdentity(req);
    const noticeId = await createNotice(pool, text, theme, identity.name || identity.email);

    // The rendered slide is an ordinary media row, so playlists, schedules and
    // the player need to know nothing about notices existing at all.
    const media = await createMedia(pool, {
      kind: "image",
      title: text.headline || text.body.slice(0, 60),
      fileName: `notice-${noticeId}.jpg`,
      mimeType: "image/jpeg",
      byteSize: 0,
      uploadedByEmail: identity.email,
      uploadedByName: identity.name,
      noticeId,
    });
    enqueueMedia(queue, pool, media, undefined, { text, theme });

    return { ok: true, notice: view((await getNotice(pool, noticeId))!) };
  });

  app.patch("/api/notices/:id", { preHandler: requirePermission("upload") }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const existing = await getNotice(pool, id);
    if (!existing) return reply.code(404).send({ ok: false, error: "No such notice." });

    const { text, theme } = read(req.body);
    const check = validateNotice(text);
    if (!check.ok) return reply.code(400).send({ ok: false, error: check.error });

    await updateNotice(pool, id, text, theme);

    // Re-render IN PLACE, onto the same media row: every playlist already
    // pointing at this notice keeps working, and the schedule is untouched.
    const media = existing.media_id ? await getMedia(pool, Number(existing.media_id)) : null;
    if (media) {
      await setMediaStatus(pool, media.id, "pending");
      enqueueMedia(queue, pool, media, undefined, { text, theme });
    }
    return { ok: true, notice: view((await getNotice(pool, id))!) };
  });

  app.delete("/api/notices/:id", { preHandler: requirePermission("upload") }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const existing = await getNotice(pool, id);
    if (!existing) return reply.code(404).send({ ok: false, error: "No such notice." });

    const identity = getIdentity(req);
    const mine = existing.created_by === (identity.name || identity.email);
    if (!mine && !req.perms?.manage) {
      return reply.code(403).send({ ok: false, error: "That notice was written by someone else." });
    }
    // Delete the media first so its bytes go with it; the notice row cascades
    // to nothing left behind.
    if (existing.media_id) await deleteMedia(pool, Number(existing.media_id));
    await deleteNotice(pool, id);
    return { ok: true };
  });
}
