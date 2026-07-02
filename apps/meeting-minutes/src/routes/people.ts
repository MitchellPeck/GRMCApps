import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { addPerson, listPeople, setPersonActive, updatePerson } from "../people";

interface AddBody { name?: string; email?: string; title?: string }
interface ToggleBody { active?: boolean }

export async function peopleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/people", async (req) => {
    try {
      const includeInactive = (req.query as { all?: string })?.all === "1";
      return { ok: true, people: await listPeople(pool, includeInactive) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.post("/api/people", async (req, reply) => {
    const b = (req.body ?? {}) as AddBody;
    const r = await addPerson(pool, b.name ?? "", b.email ?? "", b.title ?? "");
    if (!r.ok) reply.code(400);
    return r;
  });

  app.put("/api/people/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) { reply.code(400); return { ok: false, error: "Bad id." }; }
    const b = (req.body ?? {}) as AddBody;
    const r = await updatePerson(pool, id, b.name ?? "", b.email ?? "", b.title ?? "");
    if (!r.ok) reply.code(400);
    return r;
  });

  app.post("/api/people/:id/active", async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isFinite(id)) { reply.code(400); return { ok: false, error: "Bad id." }; }
      const b = (req.body ?? {}) as ToggleBody;
      await setPersonActive(pool, id, b.active !== false);
      return { ok: true };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });
}
