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
import { powerRoutes, takeoverRoutes } from "./routes/power";
import { realDeps as powerActionDeps } from "./power-actions";
import { pressKey } from "./samsung-pairing";
import { noticeRoutes } from "./routes/notices";
import { startPowerRunner } from "./power-runner";

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
app.register(powerRoutes);
app.register(takeoverRoutes);
app.register(noticeRoutes);

// The TV runs unattended for months and reloads itself once a day. If it
// caches its own HTML, CSS or JS, a fix can never reach it without somebody
// walking over with a keyboard — so these always revalidate. Media under
// /api/player/media keeps its long cache: those bytes never change, because a
// new upload gets a new id.
const ALWAYS_REVALIDATE = /^\/(player|player\.css|player\.js|index\.html|app\.css|app\.js)(\?|$)/;
app.addHook("onSend", async (req, reply) => {
  if (ALWAYS_REVALIDATE.test(req.raw.url ?? "")) {
    reply.header("cache-control", "no-cache");
  }
});

app.get("/healthz", async () => ({ ok: true, queue: queue.size() }));

async function start(): Promise<void> {
  // power-actions.ts is brand-agnostic and has no database handle, so the one
  // action that needs the stored pairing is wired in here rather than reaching
  // for the pool from inside it.
  powerActionDeps.samsung = (key) => pressKey(pool, key);

  await mkdir(join(config.dataDir, "media"), { recursive: true });
  await ensureSchema();
  await resumePending(queue, pool, (m) => app.log.info(m));
  // Watches the operating-hours clock and fires the configured power hook on
  // each boundary. The screen blanking itself does not depend on this — the
  // player works that out from the plan — so a TV that cannot be controlled
  // over the network simply goes black on time instead.
  startPowerRunner(pool, (m) => app.log.info(m));
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`narthex-tv listening on ${config.port}`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

export { app };
