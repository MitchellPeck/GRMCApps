import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getLatestGraceNotes, getLatestBlog } from "../mailchimp";

export async function mailchimpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/grace-notes", async (req) => {
    try {
      const sundayDate = (req.query as { sundayDate?: string }).sundayDate || null;
      const gn = await getLatestGraceNotes(pool, sundayDate);
      return { ok: true, ...gn };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.get("/api/blog", async () => {
    try {
      const blog = await getLatestBlog(pool);
      return { ok: true, ...blog };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
