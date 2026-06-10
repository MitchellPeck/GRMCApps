import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { join } from "node:path";
import { config } from "./config";
import { ensureSchema } from "./db";

const app = Fastify({ logger: true, trustProxy: true });

app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });

app.get("/healthz", async () => ({ ok: true }));

async function start() {
  await ensureSchema();
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`approvals listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
