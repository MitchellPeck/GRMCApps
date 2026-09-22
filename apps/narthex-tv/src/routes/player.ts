import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { join } from "node:path";
import { pool } from "../db";
import { findByToken, recordHeartbeat, ScreenRow } from "../screens";
import { buildPlan } from "../resolve";
import { getMedia, getPagePath } from "../media";
import { contentTypeFor } from "../ingest";
import { sendFile } from "../files";

/**
 * The player surface. It sits OUTSIDE the hub's forward-auth — a television
 * cannot complete a Google sign-in — so everything here is gated on a screen
 * token instead, and nothing here reveals anything a screen does not need:
 * no user list, no schedule, no other screen.
 */

const intParam = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

function tokenFrom(req: FastifyRequest): string {
  const header = req.headers["x-screen-token"];
  if (typeof header === "string" && header) return header;
  const q = req.query as { t?: string; token?: string };
  return String(q?.t ?? q?.token ?? "");
}

async function requireScreen(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<ScreenRow | null> {
  const screen = await findByToken(pool, tokenFrom(req));
  if (!screen) {
    reply.code(401).send({ ok: false, error: "This screen isn't paired." });
    return null;
  }
  return screen;
}

export async function playerRoutes(app: FastifyInstance): Promise<void> {
  // The kiosk page itself. Deliberately served without a token check: it is a
  // static shell that shows a "not paired" message until the token in its URL
  // is accepted by /api/player/plan.
  app.get("/player", async (req, reply) =>
    reply.type("text/html").sendFile("player.html", join(__dirname, "..", "public"))
  );

  app.get("/api/player/plan", async (req, reply) => {
    const screen = await requireScreen(req, reply);
    if (!screen) return reply;
    const plan = await buildPlan(pool, { at: new Date(), rotation: screen.rotation });
    return { ok: true, screen: { id: Number(screen.id), name: screen.name }, plan };
  });

  app.post("/api/player/heartbeat", async (req, reply) => {
    const screen = await requireScreen(req, reply);
    if (!screen) return reply;
    const b = (req.body ?? {}) as { revision?: string; playing?: string };
    await recordHeartbeat(pool, Number(screen.id), {
      ip: String(req.ip ?? ""),
      revision: String(b.revision ?? ""),
      playing: String(b.playing ?? ""),
    });
    return { ok: true, serverTime: new Date().toISOString() };
  });

  app.get("/api/player/media/:id/file", async (req, reply) => {
    const screen = await requireScreen(req, reply);
    if (!screen) return reply;
    const row = await getMedia(pool, intParam((req.params as { id: string }).id));
    if (!row?.play_path || row.status !== "ready") {
      return reply.code(404).send({ ok: false, error: "Not ready." });
    }
    return sendFile(req, reply, row.play_path, contentTypeFor(row.play_path), 86400);
  });

  app.get("/api/player/media/:id/page/:n", async (req, reply) => {
    const screen = await requireScreen(req, reply);
    if (!screen) return reply;
    const params = req.params as { id: string; n: string };
    const path = await getPagePath(pool, intParam(params.id), intParam(params.n));
    if (!path) return reply.code(404).send({ ok: false, error: "No such slide." });
    return sendFile(req, reply, path, "image/jpeg", 86400);
  });
}
