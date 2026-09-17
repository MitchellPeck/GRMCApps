import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { loadPermissions } from "../guard";
import { addEvent } from "../events";
import { getRequest } from "../requests";
import { addReceipt, deleteReceipt, getReceipt, listReceipts } from "../receipts";
import { MAX_FILES, MAX_FILE_BYTES } from "./extract";

const ACCEPTED = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
]);

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  // Metadata is open to anyone with app access, matching the request itself.
  app.get("/api/requests/:id/receipts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });
    return { ok: true, receipts: await listReceipts(pool, Number(id)) };
  });

  // The bytes are not. A receipt scan routinely carries a home address, a
  // partial card number and a signature, which the request's metadata does not
  // — so viewing one is limited to the people who need it.
  app.get("/api/requests/:id/receipts/:rid", async (req, reply) => {
    const { id, rid } = req.params as { id: string; rid: string };
    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });

    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const me = identity.email.toLowerCase();
    const allowed =
      perms.manage ||
      found.request.submitted_by_email.toLowerCase() === me ||
      found.request.approver_email.toLowerCase() === me;
    if (!allowed) {
      return reply.code(403).send({ ok: false, error: "You cannot view this receipt." });
    }

    const receipt = await getReceipt(pool, Number(id), Number(rid));
    if (!receipt) return reply.code(404).send({ ok: false, error: "Receipt not found." });

    return reply
      .header("content-type", receipt.mime_type)
      .header("content-disposition", `inline; filename="${receipt.file_name.replace(/"/g, "")}"`)
      .send(receipt.content);
  });

  app.post("/api/requests/:id/receipts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });

    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const own = found.request.submitted_by_email.toLowerCase() === identity.email.toLowerCase();
    if (!perms.manage && !own) {
      return reply.code(403).send({ ok: false, error: "Only the submitter can add receipts." });
    }
    if (!req.isMultipart()) {
      return reply.code(400).send({ ok: false, error: "Upload the receipts as form data." });
    }

    const added: string[] = [];
    const rejected: string[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type !== "file") continue;
        const name = part.filename || "receipt";
        if (!ACCEPTED.has(part.mimetype) || added.length >= MAX_FILES) {
          rejected.push(name);
          await part.toBuffer().catch(() => undefined);
          continue;
        }
        const buffer = await part.toBuffer();
        await addReceipt(
          pool, Number(id),
          { name, mimeType: part.mimetype, buffer },
          identity.email
        );
        added.push(name);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (/file too large|limit/i.test(message)) {
        return reply.code(413).send({
          ok: false,
          error: `Each receipt must be under ${MAX_FILE_BYTES / (1024 * 1024)} MB.`,
        });
      }
      req.log.warn({ err }, "receipt upload failed");
      return reply.code(400).send({ ok: false, error: "Could not read the upload." });
    }

    for (const name of added) {
      await addEvent(pool, Number(id), "receipt_added", identity, name);
    }
    return { ok: true, added, rejected };
  });

  app.delete("/api/requests/:id/receipts/:rid", async (req, reply) => {
    const { id, rid } = req.params as { id: string; rid: string };
    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });

    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const own = found.request.submitted_by_email.toLowerCase() === identity.email.toLowerCase();
    const editable =
      found.request.status === "pending" || found.request.status === "changes_requested";
    if (!perms.manage && !(own && editable)) {
      return reply.code(403).send({ ok: false, error: "You cannot remove this receipt." });
    }

    const removed = await deleteReceipt(pool, Number(id), Number(rid));
    if (!removed) return reply.code(404).send({ ok: false, error: "Receipt not found." });
    await addEvent(pool, Number(id), "receipt_removed", identity);
    return { ok: true };
  });
}
