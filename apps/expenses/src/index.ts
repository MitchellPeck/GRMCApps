import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { join } from "node:path";
import { config } from "./config";
import { ensureSchema } from "./db";
import { MAX_FILES, MAX_FILE_BYTES, extractRoutes } from "./routes/extract";
import { requestRoutes } from "./routes/requests";
import { chargeCodeRoutes } from "./routes/charge-codes";
import { settingsRoutes } from "./routes/settings";
import { meRoutes } from "./routes/me";

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

app.register(fastifyMultipart, {
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
});
app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });

app.register(meRoutes);
app.register(extractRoutes);
app.register(requestRoutes);
app.register(chargeCodeRoutes);
app.register(settingsRoutes);

app.get("/healthz", async () => ({ ok: true }));

ensureSchema()
  .then(() => app.listen({ host: "0.0.0.0", port: config.port }))
  .then(() => app.log.info(`expenses listening on ${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

export { app };
