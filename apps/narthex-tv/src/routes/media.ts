import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { requirePermission } from "../guard";
import { queue } from "../worker";
import { enqueueMedia } from "../queue";
import {
  createMedia, deleteMedia, getMedia, getPagePath, listMedia, mediaDir, mediaUsage,
  renameMedia, setMediaPaths, setMediaStatus,
} from "../media";
import { contentTypeFor, detectKind, safeFileName, titleFromFileName } from "../ingest";
import { sendFile } from "../files";
import { config } from "../config";
import {
  fileNameForApproval, getApprovedImageBytes, listApprovedImages,
} from "../approvals-client";
import { writeFile } from "node:fs/promises";

const intParam = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

export function mediaView(row: Awaited<ReturnType<typeof getMedia>>) {
  if (!row) return null;
  return {
    id: Number(row.id),
    kind: row.kind,
    title: row.title,
    fileName: row.file_name,
    byteSize: Number(row.byte_size),
    status: row.status,
    error: row.error,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    pageCount: Number(row.page_count ?? 0),
    hasPoster: Boolean(row.poster_path),
    uploadedBy: row.uploaded_by_name || row.uploaded_by_email,
    createdAt: row.created_at,
  };
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/media", async () => ({
    ok: true,
    media: (await listMedia(pool)).map(mediaView),
  }));

  // Upload. Each file becomes a row immediately (so the grid can show it
  // converting), its bytes land under that row's directory, and the queue picks
  // it up from there.
  app.post(
    "/api/media",
    { preHandler: requirePermission("upload") },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const id = getIdentity(req);
      const created: unknown[] = [];
      const rejected: { fileName: string; error: string }[] = [];

      let parts;
      try {
        parts = req.parts();
      } catch {
        return reply.code(400).send({ ok: false, error: "That wasn't a file upload." });
      }

      for await (const part of parts) {
        if (part.type !== "file") continue;
        const fileName = safeFileName(part.filename || "upload");
        const kind = detectKind(part.filename || "", part.mimetype || "");
        if (!kind) {
          // Drain the stream: leaving it unread stalls the rest of the upload.
          part.file.resume();
          rejected.push({
            fileName: part.filename || fileName,
            error: "Not a photo, video or presentation we can show.",
          });
          continue;
        }

        const row = await createMedia(pool, {
          kind,
          title: titleFromFileName(part.filename || fileName),
          fileName,
          mimeType: part.mimetype || "",
          byteSize: 0,
          uploadedByEmail: id.email,
          uploadedByName: id.name,
        });

        const dir = mediaDir(Number(row.id));
        const target = join(dir, `original-${fileName}`);
        try {
          await mkdir(dir, { recursive: true });
          await pipeline(part.file, createWriteStream(target));
          if (part.file.truncated) {
            throw new Error(
              `That file is larger than the ${Math.round(config.maxFileBytes / (1024 * 1024))} MB limit.`
            );
          }
          await setMediaPaths(pool, Number(row.id), { originalPath: target });
          const stored = await getMedia(pool, Number(row.id));
          if (stored) enqueueMedia(queue, pool, stored);
          created.push(mediaView(stored));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await setMediaStatus(pool, Number(row.id), "failed", message);
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          await deleteMedia(pool, Number(row.id)).catch(() => {});
          rejected.push({ fileName: part.filename || fileName, error: message });
        }
      }

      if (!created.length && rejected.length) {
        return reply.code(400).send({ ok: false, error: rejected[0].error, rejected });
      }
      return { ok: true, media: created, rejected };
    }
  );

  app.patch(
    "/api/media/:id",
    { preHandler: requirePermission("upload") },
    async (req, reply) => {
      const id = intParam((req.params as { id: string }).id);
      const body = req.body as { title?: string };
      const row = await getMedia(pool, id);
      if (!row) return reply.code(404).send({ ok: false, error: "No such media." });

      const identity = getIdentity(req);
      const mine = row.uploaded_by_email.toLowerCase() === identity.email.toLowerCase();
      if (!mine && !req.perms?.manage) {
        return reply.code(403).send({ ok: false, error: "That was uploaded by someone else." });
      }
      if (typeof body?.title === "string" && body.title.trim()) {
        await renameMedia(pool, id, body.title.trim());
      }
      return { ok: true, media: mediaView(await getMedia(pool, id)) };
    }
  );

  app.delete(
    "/api/media/:id",
    { preHandler: requirePermission("upload") },
    async (req, reply) => {
      const id = intParam((req.params as { id: string }).id);
      const row = await getMedia(pool, id);
      if (!row) return reply.code(404).send({ ok: false, error: "No such media." });

      const identity = getIdentity(req);
      const mine = row.uploaded_by_email.toLowerCase() === identity.email.toLowerCase();
      if (!mine && !req.perms?.manage) {
        return reply.code(403).send({ ok: false, error: "That was uploaded by someone else." });
      }

      const usage = await mediaUsage(pool, id);
      const force = String((req.query as { force?: string }).force ?? "") === "1";
      if (usage.length && !force) {
        return reply.code(409).send({
          ok: false,
          error: `That's still in ${usage.map((u) => `"${u.playlistName}"`).join(", ")}.`,
          usage,
        });
      }
      await deleteMedia(pool, id);
      return { ok: true };
    }
  );

  // ── import from the Approvals app ────────────────────────────────────────
  // A graphic that has already been through sign-off should not need
  // re-exporting and re-uploading to reach the screen.

  app.get("/api/approvals", { preHandler: requirePermission("upload") }, async (req, reply) => {
    try {
      return { ok: true, images: await listApprovedImages(getIdentity(req)) };
    } catch (e) {
      // Approvals being down must not look like a bug in this app.
      return reply.code(502).send({
        ok: false,
        error: `Couldn't reach the Approvals app: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

  app.post(
    "/api/media/from-approval",
    { preHandler: requirePermission("upload") },
    async (req, reply) => {
      const body = req.body as { approvalId?: unknown; title?: unknown };
      const approvalId = intParam(body?.approvalId);
      if (!approvalId) return reply.code(400).send({ ok: false, error: "Pick a graphic." });

      const identity = getIdentity(req);
      const title = String(body?.title ?? "").trim() || `Approved graphic ${approvalId}`;

      let fetched;
      try {
        fetched = await getApprovedImageBytes(identity, approvalId);
      } catch (e) {
        return reply.code(502).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      const fileName = fileNameForApproval(title, fetched.contentType);
      const row = await createMedia(pool, {
        kind: "image",
        title,
        fileName,
        mimeType: fetched.contentType,
        byteSize: fetched.bytes.length,
        uploadedByEmail: identity.email,
        uploadedByName: identity.name,
      });

      const dir = mediaDir(Number(row.id));
      const target = join(dir, `original-${fileName}`);
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(target, fetched.bytes);
        await setMediaPaths(pool, Number(row.id), { originalPath: target });
        const stored = await getMedia(pool, Number(row.id));
        // Straight onto the same queue as an upload: whatever Approvals holds
        // still has to be normalised before the player will touch it.
        if (stored) enqueueMedia(queue, pool, stored);
        return { ok: true, media: mediaView(stored) };
      } catch (e) {
        await deleteMedia(pool, Number(row.id)).catch(() => {});
        return reply.code(500).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  );

  // Previews for the admin grid. Behind the hub's forward-auth like everything
  // else on this host; the TV uses the token-gated /api/player routes instead.
  app.get("/api/media/:id/poster", async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const row = await getMedia(pool, id);
    if (!row?.poster_path) {
      return reply.code(404).send({ ok: false, error: "No preview for that." });
    }
    return sendFile(req, reply, row.poster_path, "image/jpeg");
  });

  app.get("/api/media/:id/file", async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const row = await getMedia(pool, id);
    if (!row?.play_path) return reply.code(404).send({ ok: false, error: "Nothing to show yet." });
    return sendFile(req, reply, row.play_path, contentTypeFor(row.play_path));
  });

  app.get("/api/media/:id/page/:n", async (req, reply) => {
    const params = req.params as { id: string; n: string };
    const path = await getPagePath(pool, intParam(params.id), intParam(params.n));
    if (!path) return reply.code(404).send({ ok: false, error: "No such slide." });
    return sendFile(req, reply, path, "image/jpeg");
  });
}
