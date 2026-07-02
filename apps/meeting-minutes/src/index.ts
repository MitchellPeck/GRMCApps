import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fastifyWebsocket from "@fastify/websocket";
import { join } from "node:path";
import { config } from "./config";
import { ensureSchema } from "./db";
import { meRoutes } from "./routes/me";
import { settingsRoutes } from "./routes/settings";
import { peopleRoutes } from "./routes/people";
import { meetingsRoutes } from "./routes/meetings";
import { transcribeSocket } from "./ws-proxy";

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });

// WebSocket relay for live transcription (register before static so the
// /ws/transcribe upgrade isn't shadowed by the static catch-all).
app.register(fastifyWebsocket);
app.register(transcribeSocket);

// 25 MB covers agenda PDFs/images and short per-item audio recordings.
app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });
app.register(meRoutes);
app.register(settingsRoutes);
app.register(peopleRoutes);
app.register(meetingsRoutes);

app.get("/healthz", async () => ({ ok: true }));

async function start() {
  await ensureSchema();
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`meeting-minutes listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
