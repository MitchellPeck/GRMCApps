import Fastify from "fastify";
import { config } from "./config";
import { ensureSchema } from "./db";

const app = Fastify({ logger: true, trustProxy: true });

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
