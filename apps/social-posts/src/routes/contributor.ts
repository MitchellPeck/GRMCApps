// The public side of Grace Notes. Traefik sends /gn/* past the hub login, so the token in the
// path is the only credential: an unknown or retired token gets a 404 and touches nothing.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { pool as appPool } from "../db";
import { contributorByToken } from "../gracenotes/repo";
import { Actor, addItem, confirmPiece, contributorView, dropPiece, editPiece } from "../gracenotes/pieces";
import { Contributor } from "../gracenotes/types";
import { storeUpload } from "../pipeline/uploads";
import { GnRouteOpts, guard, pieceInput } from "./gracenotes";

const MAX_IMAGE_BYTES = 10_000_000;
const DEAD_LINK = "This link isn't active. Ask Mitchell for a new one.";

// Compiled output keeps public/ next to routes/ (the Dockerfile copies it); under tests it's still in src/.
const PUBLIC_DIRS = [join(__dirname, "..", "public"), join(__dirname, "..", "..", "src", "public")];
// The shared stylesheet is copied to public/assets/ only in the Docker build; the repo copy covers dev and tests.
const SHARED_CSS = join(__dirname, "..", "..", "..", "..", "shared", "ui", "grmc.css");

const ASSETS: Record<string, { type: string; paths: () => string[] }> = {
  "contributor.js": { type: "text/javascript; charset=utf-8", paths: () => PUBLIC_DIRS.map((d) => join(d, "gn", "contributor.js")) },
  "contributor.css": { type: "text/css; charset=utf-8", paths: () => PUBLIC_DIRS.map((d) => join(d, "gn", "contributor.css")) },
  "grmc.css": { type: "text/css; charset=utf-8", paths: () => [...PUBLIC_DIRS.map((d) => join(d, "assets", "grmc.css")), SHARED_CSS] },
};
const firstExisting = (paths: string[]) => paths.find((p) => existsSync(p));

export async function contributorRoutes(app: FastifyInstance, opts: GnRouteOpts = {}): Promise<void> {
  const db: Pool = opts.db ?? appPool;

  const deadPage = (reply: FastifyReply) =>
    reply.code(404).type("text/html; charset=utf-8").send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grace Notes</title><p style="font:18px system-ui;max-width:30em;margin:3em auto;padding:0 1em">${DEAD_LINK}</p>`);
  const deadApi = (reply: FastifyReply) => reply.code(404).send({ ok: false, error: DEAD_LINK });

  // Resolves the token (or answers 404 itself and returns null).
  async function who(req: FastifyRequest, reply: FastifyReply, api: boolean): Promise<Contributor | null> {
    const c = await contributorByToken(db, (req.params as { token: string }).token);
    if (!c) { api ? deadApi(reply) : deadPage(reply); return null; }
    return c;
  }
  const actor = (c: Contributor): Actor => ({ kind: "contributor", contributor: c });
  const body = (req: FastifyRequest) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");

  // Fixed allowlist, registered before /gn/:token so "_" can never be mistaken for a token.
  app.get("/gn/_/:file", async (req, reply) => {
    const asset = Object.hasOwn(ASSETS, (req.params as { file: string }).file) ? ASSETS[(req.params as { file: string }).file] : undefined;
    const path = asset && firstExisting(asset.paths());
    if (!asset || !path) return reply.code(404).send("Not found");
    return reply.type(asset.type).header("cache-control", "public, max-age=300").send(readFileSync(path));
  });

  app.get("/gn/:token", async (req, reply) => {
    if (!(await who(req, reply, false))) return;
    const page = firstExisting(PUBLIC_DIRS.map((d) => join(d, "gn", "contributor.html")));
    if (!page) return reply.code(404).send("Not found");
    return noStore(reply).type("text/html; charset=utf-8").send(readFileSync(page));
  });

  app.get("/gn/:token/api/view", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    return noStore(reply).send(await guard(async () => ({ ok: true, name: c.name, ...(await contributorView(db, c)) })));
  });

  app.post("/gn/:token/api/pieces/:id/confirm", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    return guard(async () => {
      const r = await confirmPiece(db, (req.params as { id: string }).id, actor(c));
      return r.ok ? { ok: true } : r;
    });
  });
  app.post("/gn/:token/api/pieces/:id/edit", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    return guard(async () => {
      const r = await editPiece(db, (req.params as { id: string }).id, pieceInput(body(req)), actor(c));
      return r.ok ? { ok: true } : r;
    });
  });
  app.post("/gn/:token/api/pieces/:id/drop", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    return guard(async () => {
      const r = await dropPiece(db, (req.params as { id: string }).id, actor(c));
      return r.ok ? { ok: true } : r;
    });
  });
  app.post("/gn/:token/api/sections/:sid/items", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    return guard(async () => {
      const issue = (await contributorView(db, c)).issue;
      if (!issue) return { ok: false as const, error: "There's no issue open right now." };
      const r = await addItem(db, issue.id, (req.params as { sid: string }).sid, pieceInput(body(req)), actor(c));
      return r.ok ? { ok: true } : r;
    });
  });

  // An image arrives as its raw bytes. The parser lives in this plugin only, so it can't change
  // how the admin routes read bodies; videos are let through the parser to be refused with a message.
  app.addContentTypeParser(/^(image|video)\//, { parseAs: "buffer", bodyLimit: MAX_IMAGE_BYTES }, (_req, buf, done) => done(null, buf));
  app.post("/gn/:token/api/image", { bodyLimit: MAX_IMAGE_BYTES }, async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    return guard(async () => {
      const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!type.startsWith("image/")) throw new Error("Only pictures can be added here.");
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!bytes.length) throw new Error("That file is empty.");
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("That picture is over 10 MB.");
      const { url } = await storeUpload(db, bytes, type, "gracenotes-image");
      return { ok: true, url };
    });
  });
}
