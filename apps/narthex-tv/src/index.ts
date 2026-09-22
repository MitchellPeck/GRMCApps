import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { config } from "./config";
import { ensureSchema, pool } from "./db";
import { queue } from "./worker";
import { resumePending } from "./queue";
import { meRoutes } from "./routes/me";
import { mediaRoutes } from "./routes/media";
import { playlistRoutes } from "./routes/playlists";
import { scheduleRoutes } from "./routes/schedule";
import { screenRoutes } from "./routes/screens";
import { settingsRoutes } from "./routes/settings";
import { playerRoutes } from "./routes/player";

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

app.register(fastifyMultipart, {
  limits: { fileSize: config.maxFileBytes, files: config.maxFiles },
});
app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });

app.register(meRoutes);
app.register(mediaRoutes);
app.register(playlistRoutes);
app.register(scheduleRoutes);
app.register(screenRoutes);
app.register(settingsRoutes);
app.register(playerRoutes);

app.get("/healthz", async () => ({ ok: true, queue: queue.size() }));

async function start(): Promise<void> {
  await mkdir(join(config.dataDir, "media"), { recursive: true });
  await ensureSchema();
  await resumePending(queue, pool, (m) => app.log.info(m));
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`narthex-tv listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

export { app };
