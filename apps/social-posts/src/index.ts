import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { config } from "./config";
import { ensureSchema } from "./db";
import { meRoutes } from "./routes/me";
import { settingsRoutes } from "./routes/settings";
import { mailchimpRoutes } from "./routes/mailchimp";
import { seriesRoutes } from "./routes/series";
import { draftsRoutes } from "./routes/drafts";
import { metricoolRoutes } from "./routes/metricool";

const app = Fastify({ logger: true, trustProxy: true });

app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });
app.register(meRoutes);
app.register(settingsRoutes);
app.register(mailchimpRoutes);
app.register(seriesRoutes);
app.register(draftsRoutes);
app.register(metricoolRoutes);

app.get("/healthz", async () => ({ ok: true }));

async function start() {
  await ensureSchema();
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`social-posts listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
