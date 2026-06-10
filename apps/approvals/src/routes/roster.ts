import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { addRosterEntry, listRoster, setRosterActive } from "../roster";

interface AddBody { name?: string; email?: string }
interface ToggleBody { active?: boolean }

export async function rosterRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/roster", async (req) => {
    try {
      const includeInactive = (req.query as { all?: string })?.all === "1";
      return { ok: true, roster: await listRoster(pool, includeInactive) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.post("/api/roster", async (req, reply) => {
    const b = (req.body ?? {}) as AddBody;
    const r = await addRosterEntry(pool, b.name ?? "", b.email ?? "");
    if (!r.ok) reply.code(400);
    return r;
  });

  app.post("/api/roster/:id", async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isFinite(id)) { reply.code(400); return { ok: false, error: "Bad id." }; }
      const b = (req.body ?? {}) as ToggleBody;
      await setRosterActive(pool, id, b.active !== false);
      return { ok: true };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });
}
