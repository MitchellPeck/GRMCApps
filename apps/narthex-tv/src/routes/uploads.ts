import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { requirePermission } from "../guard";
import { queue } from "../worker";
import { enqueueMedia } from "../queue";
import { createMedia, deleteMedia, getMedia, mediaDir, setMediaPaths } from "../media";
import { detectKind, safeFileName, titleFromFileName } from "../ingest";
import { config } from "../config";
import {
  CHUNK_BYTES, Staged, UploadError, appendChunk, beginUpload, discardStaged, readStaged,
  receivedBytes, stagingRoot, takeStaged,
} from "../uploads";
import { mediaView } from "./media";

// The browser's side of this is upload() in public/app.js: start, send the
// file in CHUNK_BYTES pieces, then finish — at which point it becomes a media
// row exactly as a single-request upload used to.
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // Hand the raw body over as a stream; appendChunk does its own size checks,
  // so nothing here ever buffers a piece in memory.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  const root = stagingRoot(config.dataDir);
  const limitMb = Math.round(config.maxFileBytes / (1024 * 1024));

  async function ownStaged(req: FastifyRequest): Promise<Staged | null> {
    const staged = await readStaged(root, String((req.params as { id: string }).id));
    if (!staged) return null;
    const mine = staged.ownerEmail.toLowerCase() === getIdentity(req).email.toLowerCase();
    return mine ? staged : null;
  }

  app.post("/api/uploads", { preHandler: requirePermission("upload") }, async (req, reply) => {
    const body = req.body as { fileName?: unknown; size?: unknown; type?: unknown };
    const originalName = String(body?.fileName ?? "").trim() || "upload";
    const mimeType = String(body?.type ?? "");
    const size = Number(body?.size);

    if (!detectKind(originalName, mimeType)) {
      return reply.code(400).send({ ok: false, error: "Not a photo, video or presentation we can show." });
    }
    if (!Number.isInteger(size) || size <= 0) {
      return reply.code(400).send({ ok: false, error: "That file is empty." });
    }
    if (size > config.maxFileBytes) {
      return reply.code(413).send({ ok: false, error: `That file is larger than the ${limitMb} MB limit.` });
    }

    const identity = getIdentity(req);
    const staged = await beginUpload(root, {
      fileName: safeFileName(originalName),
      originalName,
      mimeType,
      size,
      ownerEmail: identity.email,
      ownerName: identity.name,
    });
    return { ok: true, uploadId: staged.id, chunkBytes: CHUNK_BYTES };
  });

  app.put("/api/uploads/:id", { preHandler: requirePermission("upload") }, async (req, reply) => {
    const staged = await ownStaged(req);
    if (!staged) return reply.code(404).send({ ok: false, error: "That upload has expired. Try again." });
    if (!(req.body instanceof Readable)) {
      return reply.code(415).send({ ok: false, error: "Send the piece as application/octet-stream." });
    }
    const offset = Number((req.query as { offset?: string }).offset);
    try {
      return { ok: true, received: await appendChunk(root, staged, offset, req.body) };
    } catch (e) {
      if (!(e instanceof UploadError)) throw e;
      return reply.code(e.status).send({ ok: false, error: e.message, received: e.received });
    }
  });

  app.post("/api/uploads/:id/complete", { preHandler: requirePermission("upload") }, async (req, reply) => {
    const staged = await ownStaged(req);
    if (!staged) return reply.code(404).send({ ok: false, error: "That upload has expired. Try again." });
    const received = await receivedBytes(root, staged.id);
    if (received !== staged.size) {
      return reply.code(409).send({ ok: false, error: "The file hasn't finished arriving.", received });
    }
    return finish(staged, reply);
  });

  app.delete("/api/uploads/:id", { preHandler: requirePermission("upload") }, async (req) => {
    const staged = await ownStaged(req);
    if (staged) await discardStaged(root, staged.id);
    return { ok: true };
  });

  async function finish(staged: Staged, reply: FastifyReply) {
    const row = await createMedia(pool, {
      kind: detectKind(staged.originalName, staged.mimeType)!,
      title: titleFromFileName(staged.originalName),
      fileName: staged.fileName,
      mimeType: staged.mimeType,
      byteSize: staged.size,
      uploadedByEmail: staged.ownerEmail,
      uploadedByName: staged.ownerName,
    });
    const dir = mediaDir(Number(row.id));
    const target = join(dir, `original-${staged.fileName}`);
    try {
      await mkdir(dir, { recursive: true });
      await takeStaged(root, staged.id, target);
      await setMediaPaths(pool, Number(row.id), { originalPath: target });
      const stored = await getMedia(pool, Number(row.id));
      if (stored) enqueueMedia(queue, pool, stored);
      return { ok: true, media: mediaView(stored) };
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await deleteMedia(pool, Number(row.id)).catch(() => {});
      await discardStaged(root, staged.id).catch(() => {});
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
