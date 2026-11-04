import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { deletePractice, practiceMeetingId, seedPractice } from "../demo";

// The walkthrough's practice meeting, one per person (demo.ts).
export async function practiceRoutes(app: FastifyInstance): Promise<void> {
  // Which practice meeting this person has, if any, so a tour can resume.
  app.get("/api/practice", async (req) => {
    try { return { ok: true, meetingId: await practiceMeetingId(pool, getIdentity(req).email) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  // Make it, or start it over.
  app.post("/api/practice", async (req, reply) => {
    try { return { ok: true, meetingId: await seedPractice(pool, getIdentity(req)) }; }
    catch (e) { reply.code(500); return { ok: false, error: (e as Error).message }; }
  });

  app.delete("/api/practice", async (req, reply) => {
    try { await deletePractice(pool, getIdentity(req).email); return { ok: true }; }
    catch (e) { reply.code(500); return { ok: false, error: (e as Error).message }; }
  });
}
