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
import { addDays } from "./dates";
import { getSetting, setSetting } from "./settings";
import {
  HORIZON_DAYS, IMAGE_RULE_SETTING, RUN_RECURRENCES_SETTING, applyImageRule, materialize, seedRunRecurrences,
} from "./pipeline/recurring";

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

async function keepRecurrencesAhead(): Promise<void> {
  const today = await referenceDate(pool);
  const created = await materialize(pool, today, addDays(today, HORIZON_DAYS));
  if (created) app.log.info({ created }, "recurring posts generated");
}

async function start() {
  await ensureSchema();
  const report = await backfillOnce(pool, await referenceDate(pool));
  if (report) app.log.info(report, "content pipeline backfill complete");
  if (!(await getSetting(pool, RUN_RECURRENCES_SETTING))) {
    const seeded = await seedRunRecurrences(pool, await referenceDate(pool));
    await setSetting(pool, RUN_RECURRENCES_SETTING, new Date().toISOString());
    app.log.info({ seeded }, "weekly runs set up as recurring posts");
  }
  if (!(await getSetting(pool, IMAGE_RULE_SETTING))) {
    const fixed = await applyImageRule(pool, await referenceDate(pool));
    await setSetting(pool, IMAGE_RULE_SETTING, new Date().toISOString());
    app.log.info(fixed, "instagram image rule applied to existing posts");
  }
  await keepRecurrencesAhead();
  // Daily, so the calendar always shows HORIZON_DAYS of recurring posts.
  setInterval(() => { keepRecurrencesAhead().catch((e) => app.log.error(e)); }, 24 * 60 * 60 * 1000).unref();
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`social-posts listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
