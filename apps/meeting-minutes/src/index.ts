import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { join } from "node:path";
import { config } from "./config";
import { ensureSchema } from "./db";
import { meRoutes } from "./routes/me";
import { settingsRoutes } from "./routes/settings";
import { peopleRoutes } from "./routes/people";
import { meetingsRoutes } from "./routes/meetings";
import { recoverPendingJobs, recoverPendingMeetingJobs } from "./transcribeQueue";
import { warmUpWhisper } from "./whisper";

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });

// 50 MB covers agenda PDFs/images and per-item audio recordings.
app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
app.register(fastifyStatic, { root: join(__dirname, "public"), prefix: "/" });
app.register(meRoutes);
app.register(settingsRoutes);
app.register(peopleRoutes);
app.register(meetingsRoutes);

app.get("/healthz", async () => ({ ok: true }));

async function start() {
  await ensureSchema();
  const recovered = await recoverPendingJobs();
  const recoveredMeetings = await recoverPendingMeetingJobs();
  if (recovered || recoveredMeetings) {
    app.log.info(`re-queued ${recovered} item and ${recoveredMeetings} meeting transcription job(s)`);
  }
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`meeting-minutes listening on ${config.port}`);

  // Not awaited: whisper loads its models on the first request, and that cost
  // belongs to boot rather than to whoever records first. Serving starts
  // immediately either way. Skipped when a job was recovered — that job will
  // load the models itself, and the warm-up does not run on the serial queue,
  // so racing it would only take threads away from real work.
  if (config.whisperWarmUp && !recovered && !recoveredMeetings) {
    void warmUpWhisper((m) => app.log.info(m));
  }
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
