import { FastifyInstance } from "fastify";
import { getIdentity } from "../identity";
import { loadPermissions } from "../guard";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  // Permissions travel with identity so the UI can hide what this user cannot
  // do. Every route re-checks server-side regardless.
  app.get("/api/me", async (req) => ({
    ok: true,
    ...getIdentity(req),
    permissions: await loadPermissions(req),
  }));
}
