import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { addPerson, listPeople, setPersonActive, updatePerson } from "../people";
import { learnedVoiceCounts, setLearnVoice } from "../voices";
import { getIdentity } from "../identity";

interface AddBody { name?: string; email?: string; title?: string; active?: boolean }
interface ToggleBody { active?: boolean }

export async function peopleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/people", async (req) => {
    try {
      const q = (req.query ?? {}) as { all?: string; meetingId?: string };
      const includeInactive = q.all === "1";
      // Practice people stay out of the shared list; they're offered only
      // inside the practice meeting they belong to, to whoever owns it.
      const demo = await pool.query(
        `SELECT p.id,
                EXISTS (SELECT 1 FROM meeting_attendees ma JOIN meetings m ON m.id = ma.meeting_id
                         WHERE ma.person_id = p.id AND m.id = $1 AND m.is_demo AND m.created_by_email = $2) AS shown
           FROM people p WHERE p.is_demo`,
        [Number(q.meetingId) || 0, getIdentity(req).email]
      );
      const hidden = new Set(demo.rows.filter((r) => !r.shown).map((r) => Number(r.id)));
      const people = (await listPeople(pool, includeInactive)).filter((p) => !hidden.has(p.id));
      // Whether each person's voice is learned, and from how many meetings.
      const learning = new Map((await pool.query("SELECT id, learn_voice FROM people")).rows
        .map((r) => [Number(r.id), r.learn_voice as boolean]));
      const counts = await learnedVoiceCounts(pool);
      return {
        ok: true,
        people: people.map((p) => ({ ...p, learn_voice: learning.get(p.id) !== false, voice_meetings: counts.get(p.id) ?? 0 })),
      };
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
    const active = typeof b.active === "boolean" ? b.active : undefined;
    const r = await updatePerson(pool, id, b.name ?? "", b.email ?? "", b.title ?? "", active);
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

  // Learn this person's voice, or stop and forget it.
  app.post("/api/people/:id/voice", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) { reply.code(400); return { ok: false, error: "Bad id." }; }
    const b = (req.body ?? {}) as { learn?: unknown };
    if (typeof b.learn !== "boolean") { reply.code(400); return { ok: false, error: "learn must be true or false." }; }
    await setLearnVoice(pool, id, b.learn);
    return { ok: true };
  });
}
