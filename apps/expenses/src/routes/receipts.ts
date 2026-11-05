import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { loadPermissions, rejectBadIds, requireMember } from "../guard";
import { addEvent } from "../events";
import { getRequest } from "../requests";
import { addReceipt, deleteReceipt, getReceipt, listReceipts, sha256 } from "../receipts";
import { checkAddReceipts, isOwner } from "../lifecycle";
import { MAX_FILES, MAX_FILE_BYTES } from "./extract";
import { Refusal, mutate } from "./requests";

const ACCEPTED = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
]);

// Header values must be Latin-1, and a macOS screenshot name carries a narrow
// no-break space — so the plain filename gets an ASCII stand-in and the real
// one travels RFC 5987-encoded.
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  rejectBadIds(app);

  // Metadata is open to anyone with app access, matching the request itself.
  app.get("/api/requests/:id/receipts", { preHandler: requireMember }, async (req, reply) => {
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
    const allowed =
      perms.manage ||
      isOwner(found.request, identity.email) ||
      found.request.approver_email.toLowerCase() === identity.email.toLowerCase();
    if (!allowed) {
      return reply.code(403).send({ ok: false, error: "You cannot view this receipt." });
    }

    const receipt = await getReceipt(pool, Number(id), Number(rid));
    if (!receipt) return reply.code(404).send({ ok: false, error: "Receipt not found." });

    return reply
      .header("content-type", receipt.mime_type)
      .header("content-disposition", contentDisposition(receipt.file_name))
      .send(receipt.content);
  });

  // All or nothing: every file is read before anything is stored, then all of
  // them are stored with their events in one transaction. A failure part-way
  // leaves nothing behind, so a retry never duplicates what did get through.
  app.post("/api/requests/:id/receipts", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!req.isMultipart()) {
      return reply.code(400).send({ ok: false, error: "Upload the receipts as form data." });
    }
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);

    // Check before reading megabytes of upload.
    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });
    const pre = checkAddReceipts(found.request, identity.email, perms);
    if (!pre.ok) return reply.code(pre.status).send({ ok: false, error: pre.error });

    const files: { name: string; mimeType: string; buffer: Buffer }[] = [];
    const rejected: string[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type !== "file") continue;
        const name = part.filename || "receipt";
        if (!ACCEPTED.has(part.mimetype)) {
          rejected.push(name);
          await part.toBuffer().catch(() => undefined);
          continue;
        }
        files.push({ name, mimeType: part.mimetype, buffer: await part.toBuffer() });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (/file too large/i.test(message)) {
        return reply.code(413).send({
          ok: false,
          error: `Each receipt must be under ${MAX_FILE_BYTES / (1024 * 1024)} MB. Nothing was uploaded.`,
        });
      }
      if (/limit/i.test(message)) {
        return reply.code(413).send({
          ok: false,
          error: `Upload at most ${MAX_FILES} receipts at a time. Nothing was uploaded.`,
        });
      }
      req.log.warn({ err }, "receipt upload failed");
      return reply.code(400).send({ ok: false, error: "Could not read the upload. Nothing was uploaded." });
    }

    return mutate(reply, Number(id), async (db, locked) => {
      const guard = checkAddReceipts(locked.request, identity.email, perms);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);
      for (const f of files) {
        await addReceipt(db, Number(id), f, identity.email);
        await addEvent(db, Number(id), "receipt_added", identity, f.name, {
          bytes: f.buffer.length,
          sha256: sha256(f.buffer),
        });
      }
      return { ok: true, added: files.map((f) => f.name), rejected };
    });
  });

  app.delete("/api/requests/:id/receipts/:rid", async (req, reply) => {
    const { id, rid } = req.params as { id: string; rid: string };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);

    return mutate(reply, Number(id), async (db, found) => {
      // Once a request is decided its receipts are its substantiation, and they
      // stay. Before then the owner may swap a wrong file out.
      const undecided =
        (found.request.status === "pending" || found.request.status === "changes_requested") &&
        found.request.approved_amount === null;
      if (!undecided) throw new Refusal(409, "Receipts stay on a request once it has been approved.");
      if (!perms.manage && !isOwner(found.request, identity.email)) {
        throw new Refusal(403, "You cannot remove this receipt.");
      }
      const name = await deleteReceipt(db, Number(id), Number(rid));
      if (name === null) throw new Refusal(404, "Receipt not found.");
      await addEvent(db, Number(id), "receipt_removed", identity, name);
      return { ok: true };
    });
  });
}
