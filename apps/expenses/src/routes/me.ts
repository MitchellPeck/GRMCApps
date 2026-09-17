import { FastifyInstance } from "fastify";
import { getIdentity } from "../identity";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/me", async (req) => ({ ok: true, ...getIdentity(req) }));
}
