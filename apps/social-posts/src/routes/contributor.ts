// The public side of Grace Notes. Traefik sends /gn/* past the hub login, so the token in the
// path is the only credential: an unknown or retired token gets a 404 and touches nothing.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { pool as appPool } from "../db";
import { getSetting } from "../settings";
import { contributorByToken } from "../gracenotes/repo";
import { deadlineLabel, loadSchedule } from "../gracenotes/clock";
import { Actor, addItem, confirmPiece, contributorView, dropPiece, editPiece } from "../gracenotes/pieces";
import { Contributor } from "../gracenotes/types";
import { storeUpload } from "../pipeline/uploads";
import { GnRouteOpts, pieceInput } from "./gracenotes";

const MAX_IMAGE_BYTES = 10_000_000;
const GENERIC_ERROR = "Something went wrong. Try again in a minute.";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const FONT_FILE = /^[A-Za-z0-9._-]+\.(woff2?|ttf|otf)$/;
const FONT_TYPES: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" };
// An error written for the volunteer; anything else thrown on these public routes gets the generic line.
class UserError extends Error {}
const DEAD_LINK = "This link isn't active. Ask Mitchell for a new one.";

// Compiled output keeps public/ next to routes/ (the Dockerfile copies it); under tests it's still in src/.
const PUBLIC_DIRS = [join(__dirname, "..", "public"), join(__dirname, "..", "..", "src", "public")];
// The shared stylesheet is copied to public/assets/ only in the Docker build; the repo copy covers dev and tests.
const FONT_DIRS = [...PUBLIC_DIRS.map((d) => join(d, "assets", "fonts")), join(__dirname, "..", "..", "..", "..", "shared", "ui", "fonts")];
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
  // Scoped to this plugin: the admin routes keep their own error behaviour.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof UserError) return reply.code(200).send({ ok: false, error: err.message });
    if (err.statusCode === 413 || err.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send({ ok: false, error: "That picture is over 10 MB." });
    if (err.statusCode === 415) return reply.code(415).send({ ok: false, error: "Upload a photo (JPG, PNG, GIF or WebP)." });
    req.log.error({ err }, "grace notes public route failed");
    return reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ ok: false, error: GENERIC_ERROR });
  });
  const failed = (error: string) => ({ ok: false as const, error });

  // A public picture link must be one we handed out: https and under the R2 public base.
  async function badImageUrl(input: { imageUrl?: string }): Promise<boolean> {
    const url = input.imageUrl;
    if (!url) return false; // empty clears; undefined leaves it alone
    const base = (await getSetting(db, "r2_public_base_url")).trim().replace(/\/+$/, "");
    return !(base && /^https:\/\/[^\s"'<>]+$/i.test(url) && base.toLowerCase().startsWith("https://") && url.toLowerCase().startsWith(base.toLowerCase() + "/"));
  }
  const BAD_IMAGE = "Upload the picture here instead.";
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

  app.get("/gn/_/fonts/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const path = FONT_FILE.test(file) ? firstExisting(FONT_DIRS.map((d) => join(d, file))) : undefined;
    if (!path) return reply.code(404).send("Not found");
    return reply.type(FONT_TYPES[file.split(".").pop()!.toLowerCase()]).header("cache-control", "public, max-age=86400").send(readFileSync(path));
  });

  const pageHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await who(req, reply, false))) return;
    const page = firstExisting(PUBLIC_DIRS.map((d) => join(d, "gn", "contributor.html")));
    if (!page) return reply.code(404).send("Not found");
    return noStore(reply).type("text/html; charset=utf-8").send(readFileSync(page));
  };
  app.get("/gn/:token", pageHandler);
  app.get("/gn/:token/", pageHandler); // a link pasted with a trailing slash

  app.get("/gn/:token/api/view", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    const deadline = deadlineLabel(await loadSchedule(db));
    return noStore(reply).send({ ok: true, name: c.name, deadline, ...(await contributorView(db, c)) });
  });

  app.post("/gn/:token/api/pieces/:id/confirm", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    const r = await confirmPiece(db, (req.params as { id: string }).id, actor(c));
    return r.ok ? { ok: true } : r;
  });
  app.post("/gn/:token/api/pieces/:id/edit", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    const input = pieceInput(body(req));
    if (await badImageUrl(input)) return failed(BAD_IMAGE);
    const r = await editPiece(db, (req.params as { id: string }).id, input, actor(c));
    return r.ok ? { ok: true } : r;
  });
  app.post("/gn/:token/api/pieces/:id/drop", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    const r = await dropPiece(db, (req.params as { id: string }).id, actor(c));
    return r.ok ? { ok: true } : r;
  });
  app.post("/gn/:token/api/sections/:sid/items", async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    const input = pieceInput(body(req));
    if (await badImageUrl(input)) return failed(BAD_IMAGE);
    const issue = (await contributorView(db, c)).issue;
    if (!issue) return failed("There's no issue open right now.");
    const r = await addItem(db, issue.id, (req.params as { sid: string }).sid, input, actor(c));
    return r.ok ? { ok: true } : r;
  });

  // An image arrives as its raw bytes. The parser lives in this plugin only, so it can't change
  // how the admin routes read bodies; videos are let through the parser to be refused with a message.
  app.addContentTypeParser(/^(image|video)\//, { parseAs: "buffer", bodyLimit: MAX_IMAGE_BYTES }, (_req, buf, done) => done(null, buf));
  // The token is checked in onRequest, before the body is read, so a dead link never buffers 10 MB.
  app.post("/gn/:token/api/image", {
    bodyLimit: MAX_IMAGE_BYTES,
    onRequest: async (req, reply) => {
      if (!(await who(req, reply, true))) return reply;
    },
  }, async (req, reply) => {
    const c = await who(req, reply, true);
    if (!c) return;
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) throw new UserError("Upload a photo (JPG, PNG, GIF or WebP).");
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) throw new UserError("That file is empty.");
    if (bytes.length > MAX_IMAGE_BYTES) throw new UserError("That picture is over 10 MB.");
    const { url } = await storeUpload(db, bytes, type, "gracenotes-image");
    return { ok: true, url };
  });
}
