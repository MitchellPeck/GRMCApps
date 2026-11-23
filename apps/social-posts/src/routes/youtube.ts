// YouTube connection and video list for the drafting source picker.
import { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db";
import { CALLBACK_PATH, authUrl, disconnect, finishAuth, getCaptions, listVideos } from "../youtube";

const fail = (e: unknown) => ({ ok: false, error: (e as Error).message });

/** The address Google sends the browser back to; it must be listed on the OAuth client exactly. */
export function callbackUrl(req: FastifyRequest): string {
  const h = req.headers;
  const proto = String(h["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(h["x-forwarded-host"] || h.host || "").split(",")[0].trim();
  return `${proto}://${host}${CALLBACK_PATH}`;
}

export async function youtubeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/youtube/redirect-uri", async (req) => ({ ok: true, redirectUri: callbackUrl(req) }));

  // A plain link from Settings: off to Google, then back to the callback.
  app.get("/api/youtube/connect", async (req, reply) => {
    try { return reply.redirect(await authUrl(pool, callbackUrl(req))); }
    catch (e) { return reply.redirect("/#settings/" + encodeURIComponent((e as Error).message)); }
  });

  app.get(CALLBACK_PATH, async (req, reply) => {
    const q = req.query as Record<string, string>;
    let msg: string;
    try {
      if (q.error) throw new Error(q.error === "access_denied" ? "Sign-in was cancelled." : "Google said: " + q.error);
      msg = "Connected to " + (await finishAuth(pool, String(q.code || ""), String(q.state || ""), callbackUrl(req))) + ".";
    } catch (e) { msg = (e as Error).message; }
    return reply.redirect("/#settings/" + encodeURIComponent(msg));
  });

  app.post("/api/youtube/disconnect", async () => {
    try { await disconnect(pool); return { ok: true }; } catch (e) { return fail(e); }
  });

  app.get("/api/youtube/videos", async () => {
    try { return { ok: true, videos: await listVideos(pool) }; } catch (e) { return fail(e); }
  });

  // Fetch a video's captions again (say, after they were fixed in YouTube Studio).
  app.post("/api/youtube/videos/:id/captions", async (req) => {
    try {
      const c = await getCaptions(pool, (req.params as Record<string, string>).id, true);
      return { ok: true, trackKind: c.trackKind, length: c.text.length };
    } catch (e) { return fail(e); }
  });
}
