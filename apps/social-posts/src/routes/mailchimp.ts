import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getLatestGraceNotes, getLatestBlog } from "../mailchimp";

export async function mailchimpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/grace-notes", async (req) => {
    try {
      const sundayDate = (req.query as { sundayDate?: string }).sundayDate || null;
      const gn = await getLatestGraceNotes(pool, sundayDate);
      return { ok: true, subject: gn.subject, archiveUrl: gn.archiveUrl, status: gn.status, sentAt: gn.sentAt, preview: gn.preview };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.get("/api/blog", async () => {
    try {
      const blog = await getLatestBlog(pool);
      return { ok: true, subject: blog.subject, archiveUrl: blog.archiveUrl, status: blog.status, sentAt: blog.sentAt, preview: blog.preview };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
