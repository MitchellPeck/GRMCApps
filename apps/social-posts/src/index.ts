import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { config } from "./config";
import { ensureSchema, pool } from "./db";
import { meRoutes } from "./routes/me";
import { settingsRoutes } from "./routes/settings";
import { mailchimpRoutes } from "./routes/mailchimp";
import { seriesRoutes } from "./routes/series";
import { draftsRoutes } from "./routes/drafts";
import { metricoolRoutes } from "./routes/metricool";
import { podcastRoutes } from "./routes/podcast";
import { pipelineRoutes } from "./routes/pipeline";
import { backfillOnce } from "./pipeline/sync";
import { referenceDate } from "./schedule";

const app = Fastify({ logger: true, trustProxy: true });

app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });
app.register(meRoutes);
app.register(settingsRoutes);
app.register(mailchimpRoutes);
app.register(seriesRoutes);
app.register(draftsRoutes);
app.register(metricoolRoutes);
app.register(podcastRoutes);
app.register(pipelineRoutes);

app.get("/healthz", async () => ({ ok: true }));

async function start() {
  await ensureSchema();
  const report = await backfillOnce(pool, await referenceDate(pool));
  if (report) app.log.info(report, "content pipeline backfill complete");
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`social-posts listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
