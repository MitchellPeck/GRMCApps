import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { listEpisodes, listPodcasts } from "../buzzsprout";

export async function podcastRoutes(app: FastifyInstance): Promise<void> {
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
}
