import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { getRecentDrafts } from "../drafts";
import { draftMondayPosts, draftWedPosts, draftFridayPost } from "../runs";

export async function draftsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/drafts", async () => getRecentDrafts(pool));

  app.post("/api/draft/monday", async (req) =>
    draftMondayPosts(pool, (req.body ?? {}) as any, getIdentity(req).email));

  app.post("/api/draft/wednesday", async (req) =>
    draftWedPosts(pool, (req.body ?? {}) as any, getIdentity(req).email));

  app.post("/api/draft/friday", async (req) =>
    draftFridayPost(pool, (req.body ?? {}) as any, getIdentity(req).email));
}
