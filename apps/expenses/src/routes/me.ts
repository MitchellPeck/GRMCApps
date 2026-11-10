import { FastifyInstance } from "fastify";
import { getIdentity } from "../identity";
import { loadPermissions } from "../guard";
import { approvesAny, seesAll, seesReports } from "../permissions";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  // Permissions travel with identity so the UI can hide what this user cannot
  // do. Every route re-checks server-side regardless.
  app.get("/api/me", async (req) => {
    const p = await loadPermissions(req);
    return {
      ok: true,
      ...getIdentity(req),
      permissions: { ...p, approveAny: approvesAny(p), viewAll: seesAll(p), reports: seesReports(p), office: p.manage || p.pay },
    };
  });
}
