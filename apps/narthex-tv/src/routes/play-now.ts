import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { requirePermission } from "../guard";
import { getIdentity } from "../identity";
import { getMedia } from "../media";
import { clearPlayNow, getPlayNow, PlayNowTarget, startPlayNow } from "../play-now";
import { getPlaylist, listItems } from "../playlists";
import { recordPowerEvent } from "../power-events";
import { tickPower } from "../power-runner";
import { realDeps as powerDeps } from "../power-actions";

export async function playNowRoutes(app: FastifyInstance): Promise<void> {
  // Now, not on the next 30-second tick: pressing Play now with the TV off
  // should wake it while the person is still standing in front of it, and
  // clearing it with nothing scheduled should put it straight back to sleep.
  const tickNow = () =>
    tickPower(pool, {
      now: () => new Date(),
      actions: powerDeps,
      log: (m) => app.log.info(m),
    }).catch((e) => app.log.error(e));

  app.get("/api/play-now", async () => ({ ok: true, playNow: await getPlayNow(pool) }));

  app.post("/api/play-now", { preHandler: requirePermission("schedule") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const mediaId = Number(b.mediaId);
    const playlistId = Number(b.playlistId);
    let target: PlayNowTarget;
    if (Number.isInteger(playlistId) && playlistId > 0) {
      const playlist = await getPlaylist(pool, playlistId);
      if (!playlist || playlist.archived) {
        return reply.code(400).send({ ok: false, error: "No such playlist." });
      }
      // Waking the TV for a black screen helps nobody standing in front of it.
      const items = await listItems(pool, playlistId);
      if (!items.some((i) => i.enabled && i.status === "ready")) {
        return reply.code(400).send({ ok: false, error: "That playlist has nothing ready to show yet." });
      }
      target = { playlistId };
    } else {
      const media = Number.isInteger(mediaId) && mediaId > 0 ? await getMedia(pool, mediaId) : null;
      if (!media || media.status !== "ready") {
        return reply.code(400).send({ ok: false, error: "That item isn't ready to play yet." });
      }
      target = { mediaId };
    }
    const id = getIdentity(req);
    const playNow = await startPlayNow(pool, target, id.name || id.email);
    await recordPowerEvent(pool, "play-now-on", true, `${playNow.title} — by ${playNow.startedBy}`);
    await tickNow();
    return { ok: true, playNow };
  });

  app.delete("/api/play-now", { preHandler: requirePermission("schedule") }, async (req) => {
    await clearPlayNow(pool);
    const id = getIdentity(req);
    await recordPowerEvent(pool, "play-now-off", true, `cleared by ${id.name || id.email}`);
    await tickNow();
    return { ok: true };
  });
}
