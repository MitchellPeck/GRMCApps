import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { config } from "./config";
import { ensureSchema, pool } from "./db";
import { meRoutes } from "./routes/me";
import { settingsRoutes } from "./routes/settings";
import { metricoolRoutes } from "./routes/metricool";
import { podcastRoutes } from "./routes/podcast";
import { pipelineRoutes } from "./routes/pipeline";
import { mcpRoutes } from "./routes/mcp";
import { backfillOnce } from "./pipeline/sync";
import { migrateDrafting } from "./pipeline/migrate-drafting";
import { recoverSermons, sermonOpts } from "./pipeline/sermons";
import { backfillLinks } from "./pipeline/metricool-links";
import { checkPublished } from "./pipeline/publish-check";
import { syncMetricool } from "./pipeline/metricool-sync";
import { referenceDate } from "./schedule";
import { addDays, DEFAULT_TZ } from "./dates";
import { getSetting, setSetting } from "./settings";
import {
  HORIZON_DAYS, IMAGE_RULE_SETTING, RUN_RECURRENCES_SETTING, applyImageRule, materialize, seedRunRecurrences,
} from "./pipeline/recurring";

const app = Fastify({ logger: true, trustProxy: true });

app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });
app.register(meRoutes);
app.register(settingsRoutes);
app.register(metricoolRoutes);
app.register(podcastRoutes);
app.register(pipelineRoutes);
app.register(mcpRoutes);
// The pipeline is the app now; old bookmarks to /pipeline land on it.
app.get("/pipeline", async (_req, reply) => reply.redirect("/", 301));

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
  const linked = await backfillLinks(pool, (await getSetting(pool, "default_timezone")) || DEFAULT_TZ);
  if (linked) app.log.info({ linked }, "Metricool links backfilled from the send log");
  const drafting = await migrateDrafting(pool, await referenceDate(pool));
  if (drafting.ran) app.log.info(drafting, "weekly runs set up as drafting profiles");
  const sermons = await recoverSermons(pool, sermonOpts());
  if (sermons.resumed || sermons.dropped) app.log.info(sermons, "sermon transcriptions picked back up");
  await keepRecurrencesAhead();
  // Daily, so the calendar always shows HORIZON_DAYS of recurring posts.
  setInterval(() => { keepRecurrencesAhead().catch((e) => app.log.error(e)); }, 24 * 60 * 60 * 1000).unref();
  // Hand-scheduled posts become Published once their time passes; posts in
  // Metricool are synced from its planner. Once now, then every 30 minutes.
  const publishCheck = async () => {
    // Each step catches its own failure: a bad sync must never take the server down.
    await checkPublished(pool)
      .then((r) => { if (r.published) app.log.info(r, "publish check"); })
      .catch((e) => app.log.warn(e, "publish check failed"));
    await syncMetricool(pool)
      .then((r) => {
        if (r.error) app.log.warn({ error: r.error }, "Metricool sync couldn't read the planner");
        else if (Object.values(r).some((n) => n)) app.log.info(r, "Metricool sync");
      })
      .catch((e) => app.log.warn(e, "Metricool sync failed"));
  };
  publishCheck();
  setInterval(publishCheck, 30 * 60 * 1000).unref();
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`social-posts listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
