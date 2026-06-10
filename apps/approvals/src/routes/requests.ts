import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { validateUpload } from "../validation";
import { DecisionAction } from "../approval";
import {
  createRequest, listRequests, getRequestDetail,
  recordDecision, addVersion, getVersionImage, UploadFile,
} from "../requests";

// Pull a single file part + text fields out of a multipart request.
async function readMultipart(req: FastifyRequest): Promise<{
  fields: Record<string, string>;
  file: UploadFile | null;
}> {
  const fields: Record<string, string> = {};
  let file: UploadFile | null = null;
  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      file = { fileName: part.filename, mimeType: part.mimetype, buffer };
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  return { fields, file };
}

export async function requestsRoutes(app: FastifyInstance): Promise<void> {
  // List inbox or sent.
  app.get("/api/requests", async (req) => {
    try {
      const id = getIdentity(req);
      const box = (req.query as { box?: string })?.box === "sent" ? "sent" : "inbox";
      return { ok: true, requests: await listRequests(pool, box, id.email) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // Detail.
  app.get("/api/requests/:id", async (req, reply) => {
    const id = getIdentity(req);
    const reqId = Number((req.params as { id: string }).id);
    const r = await getRequestDetail(pool, reqId, id.email);
    if (!r.ok) reply.code(r.status);
    return r;
  });

  // Serve version image bytes.
  app.get("/api/requests/:id/versions/:n/image", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = getIdentity(req);
    const p = req.params as { id: string; n: string };
    const r = await getVersionImage(pool, Number(p.id), Number(p.n), id.email);
    if (!r.ok) { reply.code(r.status); return { ok: false, error: r.error }; }
    reply
      .header("Content-Type", r.mimeType)
      .header("Content-Disposition", `inline; filename="${r.fileName.replace(/"/g, "")}"`)
      .header("Cache-Control", "private, max-age=300");
    return reply.send(r.image);
  });

  // Create (multipart).
  app.post("/api/requests", async (req, reply) => {
    try {
      const id = getIdentity(req);
      const { fields, file } = await readMultipart(req);
      if (!file) { reply.code(400); return { ok: false, error: "A file is required." }; }
      const v = validateUpload(file.mimeType, file.buffer.length);
      if (!v.ok) { reply.code(400); return { ok: false, error: v.error }; }
      const approverId = Number(fields.approverId);
      if (!Number.isFinite(approverId)) { reply.code(400); return { ok: false, error: "An approver is required." }; }
      const r = await createRequest(pool, {
        title: fields.title ?? "",
        description: fields.description ?? "",
        approverId,
        submitter: { email: id.email, name: id.name },
        file,
      });
      if (!r.ok) reply.code(r.status);
      return r;
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });

  // Decision (JSON).
  app.post("/api/requests/:id/decision", async (req, reply) => {
    const id = getIdentity(req);
    const reqId = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { action?: string; comment?: string };
    const action = b.action as DecisionAction;
    if (!["approve", "reject", "request_changes"].includes(action)) {
      reply.code(400);
      return { ok: false, error: "Invalid action." };
    }
    const r = await recordDecision(pool, reqId, id.email, action, b.comment ?? "", id.name);
    if (!r.ok) reply.code(r.status);
    return r;
  });

  // New version (multipart).
  app.post("/api/requests/:id/versions", async (req, reply) => {
    try {
      const id = getIdentity(req);
      const reqId = Number((req.params as { id: string }).id);
      const { fields, file } = await readMultipart(req);
      if (!file) { reply.code(400); return { ok: false, error: "A file is required." }; }
      const v = validateUpload(file.mimeType, file.buffer.length);
      if (!v.ok) { reply.code(400); return { ok: false, error: v.error }; }
      const r = await addVersion(pool, reqId, id.email, file, fields.note ?? "", id.name);
      if (!r.ok) reply.code(r.status);
      return r;
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });
}
