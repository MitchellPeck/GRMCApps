import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { MISSING_KEY_ERROR, UploadedDoc, extractDocuments } from "../extract";

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export async function extractRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/extract", async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(400).send({ ok: false, error: "Upload the receipts as form data." });
    }

    const docs: UploadedDoc[] = [];
    const rejected: string[] = [];

    try {
      for await (const part of req.parts()) {
        if (part.type !== "file") continue;
        const name = part.filename || "receipt.pdf";

        // Anything that isn't a PDF is named back rather than silently ignored,
        // so an accidental screenshot upload explains itself.
        if (part.mimetype !== "application/pdf") {
          rejected.push(name);
          await part.toBuffer().catch(() => undefined);
          continue;
        }
        if (docs.length >= MAX_FILES) {
          rejected.push(name);
          await part.toBuffer().catch(() => undefined);
          continue;
        }
        docs.push({ name, buffer: await part.toBuffer() });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (/file too large|limit/i.test(message)) {
        return reply.code(413).send({
          ok: false,
          error: `Each receipt must be under ${MAX_FILE_BYTES / (1024 * 1024)} MB.`,
        });
      }
      req.log.warn({ err }, "upload failed");
      return reply.code(400).send({ ok: false, error: "Could not read the upload." });
    }

    if (!docs.length) {
      return reply.code(400).send({
        ok: false,
        error: rejected.length ? `Not a PDF: ${rejected.join(", ")}` : "Add at least one PDF first.",
      });
    }

    try {
      const result = await extractDocuments(pool, docs, req.log);
      return { ok: true, ...result, rejected, documentCount: docs.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Extraction failed.";
      if (message === MISSING_KEY_ERROR) return reply.code(400).send({ ok: false, error: message });
      req.log.error({ err }, "extraction failed");
      return reply.code(502).send({ ok: false, error: "Extraction failed. Try again." });
    }
  });
}
