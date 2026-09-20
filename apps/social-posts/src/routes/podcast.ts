import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { listEpisodes, listPodcasts } from "../buzzsprout";
import { ANGLES } from "../podcast-angles";
import { draftPodcastPosts } from "../runs";

export async function podcastRoutes(app: FastifyInstance): Promise<void> {
  // The angle menu is server-owned so the checkboxes and the prompt can never
  // drift apart.
  app.get("/api/podcast/angles", async () => ({
    ok: true,
    angles: ANGLES.map((a) => ({ key: a.key, label: a.label })),
  }));

  app.get("/api/podcast/podcasts", async () => {
    try {
      return { ok: true, podcasts: await listPodcasts(pool) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.get("/api/podcast/episodes", async () => {
    try {
      return { ok: true, episodes: await listEpisodes(pool) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.post("/api/draft/podcast", async (req) =>
    draftPodcastPosts(pool, (req.body ?? {}) as any, getIdentity(req).email));
}
