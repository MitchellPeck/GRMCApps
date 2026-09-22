import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { requirePermission } from "../guard";
import {
  createScreen, deleteScreen, listScreens, normalizeRotation, rotateToken, ScreenRow, updateScreen,
} from "../screens";

const intParam = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

// The token IS the credential, so it is only ever handed to someone who may
// manage screens — that is what the preHandler on every route here is for.
function screenView(row: ScreenRow) {
  return {
    id: Number(row.id),
    name: row.name,
    token: row.token,
    rotation: row.rotation,
    enabled: row.enabled,
    lastSeenAt: row.last_seen_at,
    lastSeenIp: row.last_seen_ip,
    lastRevision: row.last_revision,
    lastPlaying: row.last_playing,
    createdAt: row.created_at,
  };
}

export async function screenRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/screens", { preHandler: requirePermission("manage") }, async () => ({
    ok: true,
    screens: (await listScreens(pool)).map(screenView),
  }));

  app.post("/api/screens", { preHandler: requirePermission("manage") }, async (req, reply) => {
    const body = req.body as { name?: string; rotation?: number };
    const name = String(body?.name ?? "").trim();
    if (!name) return reply.code(400).send({ ok: false, error: "Give the screen a name." });
    const row = await createScreen(pool, {
      name,
      rotation: normalizeRotation(body?.rotation),
      createdByEmail: getIdentity(req).email,
    });
    return { ok: true, screen: screenView(row) };
  });

  app.patch("/api/screens/:id", { preHandler: requirePermission("manage") }, async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const b = req.body as Record<string, unknown>;
    await updateScreen(pool, id, {
      name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined,
      rotation: b.rotation === undefined ? undefined : normalizeRotation(b.rotation),
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
    });
    return { ok: true, screens: (await listScreens(pool)).map(screenView) };
  });

  // Issues a new token and invalidates the old one — what you do when a kiosk
  // URL has been on a screen someone photographed.
  app.post("/api/screens/:id/rotate-token", { preHandler: requirePermission("manage") }, async (req, reply) => {
    const token = await rotateToken(pool, intParam((req.params as { id: string }).id));
    if (!token) return reply.code(404).send({ ok: false, error: "No such screen." });
    return { ok: true, token };
  });

  app.delete("/api/screens/:id", { preHandler: requirePermission("manage") }, async (req, reply) => {
    const gone = await deleteScreen(pool, intParam((req.params as { id: string }).id));
    if (!gone) return reply.code(404).send({ ok: false, error: "No such screen." });
    return { ok: true };
  });
}
