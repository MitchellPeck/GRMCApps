import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getAllSeries, getSeriesPosts, createSeries, updateSeriesPostField, updateSeriesMeta } from "../series";

export async function seriesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/series", async () => getAllSeries(pool));

  app.get("/api/series/:id/posts", async (req) => {
    const { id } = req.params as { id: string };
    return getSeriesPosts(pool, id);
  });

  app.post("/api/series", async (req) => {
    return createSeries(pool, (req.body ?? {}) as any);
  });

  app.patch("/api/series/:id/posts/:idx", async (req) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const { field, value } = (req.body ?? {}) as { field: string; value: string };
    return updateSeriesPostField(pool, id, Number(idx), field, value);
  });

  app.patch("/api/series/:id", async (req) => {
    const { id } = req.params as { id: string };
    return updateSeriesMeta(pool, id, (req.body ?? {}) as Record<string, string>);
  });
}
