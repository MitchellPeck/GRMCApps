import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { getSettingsView } from "../settings";
import { getMetricoolCreds, listBrands, normalizeMedia, PublishMode } from "../metricool";
import { listApprovedImages, getApprovedImageBytes } from "../approvals-client";
import { getR2Creds, uploadPublic } from "../r2";
import { sendToMetricool } from "../pipeline/metricool-send";
import { gatherSendMedia } from "../metricool-media";

interface SendBody {
  text: string; networks: string[]; dateTime: string; timezone: string;
  /** "scheduled" or "draft" — the sender's choice, never guessed. */
  publish?: string;
  imageUrl?: string; approvedImageId?: string; sourceType?: string; sourceRef?: string;
  /** A browser-uploaded image, as a `data:image/...;base64,...` URL. */
  imageData?: string;
  /** Every image (or video) ticked in the send box, in order. Several make a carousel. */
  media?: Array<{ approvedImageId?: string; imageUrl?: string }>;
  /** The pipeline post this text came from, so a successful send can mark it Scheduled and link it. */
  contentItemId?: string;
  /** A different text per network; each distinct text goes as its own Metricool post. */
  texts?: Record<string, string>;
  /** network → YYYY-MM-DDTHH:MM:SS, when platforms go at different times. */
  networkTimes?: Record<string, string>;
}

// What went into the send log's image column: the approved-image id, the pasted
// url, or just a marker that the user uploaded a file (the bytes aren't worth
// storing twice — the R2 url is logged alongside).
function imageRefOf(b: SendBody): string {
  if (b.imageData) return "upload";
  if (b.media && b.media.length) return b.media.map((m) => m.approvedImageId || m.imageUrl || "").join(" ");
  return b.approvedImageId || b.imageUrl || "";
}

export async function metricoolRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/metricool/status", async () => {
    try {
      const v = await getSettingsView(pool);
      return { ok: true, hasMetricool: v.hasMetricool, hasR2: v.hasR2 };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  app.get("/api/metricool/brands", async () => {
    try { return { ok: true, brands: await listBrands(await getMetricoolCreds(pool)) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  app.get("/api/metricool/approved-images", async (req) => {
    try { return { ok: true, images: await listApprovedImages(getIdentity(req)) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  // Uploaded images arrive base64-encoded in the JSON body, so this route needs
  // more headroom than Fastify's 1 MB default.
  app.post("/api/metricool/send", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const b = (req.body ?? {}) as SendBody;
    return sendToMetricool(pool, {
      text: b.text || "", texts: b.texts, networks: b.networks, dateTime: b.dateTime, timezone: b.timezone,
      networkTimes: b.networkTimes, publish: b.publish as PublishMode, contentItemId: b.contentItemId,
      sourceType: b.sourceType || "", sourceRef: b.sourceRef || "", imageRef: imageRefOf(b), createdBy: getIdentity(req).email,
    }, {
      creds: () => getMetricoolCreds(pool),
      media: (creds) => gatherSendMedia(b, {
        approvedBytes: (id) => getApprovedImageBytes(getIdentity(req), id),
        toR2: async (bytes, contentType, seed) => uploadPublic(await getR2Creds(pool), bytes, contentType, seed),
        normalize: (url) => normalizeMedia(creds, url),
      }),
      warn: (e) => req.log.warn(e),
    });
  });
}
