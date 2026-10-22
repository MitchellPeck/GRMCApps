import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { getSettingsView } from "../settings";
import { getMetricoolCreds, isPublishMode, listBrands, normalizeMedia, schedulePost, buildSchedulerPayload, charWarnings } from "../metricool";
import { logSend } from "../metricool-sends";
import { listApprovedImages, getApprovedImageBytes } from "../approvals-client";
import { getR2Creds, uploadPublic } from "../r2";
import { markSentToMetricool } from "../pipeline/sync";
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
  /** The pipeline post this text came from, so a successful send can mark it Scheduled. */
  contentItemId?: string;
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
    const email = getIdentity(req).email;
    let mediaUrls: string[] = []; // hoisted so the error path can log orphaned R2 urls
    try {
      if (!isPublishMode(b.publish)) throw new Error("Say whether to schedule it or send it as a draft.");
      const publish = b.publish;
      const creds = await getMetricoolCreds(pool);
      const networks = Array.isArray(b.networks) ? b.networks : [];
      const warnings = charWarnings(b.text || "", networks);

      mediaUrls = await gatherSendMedia(b, {
        approvedBytes: (id) => getApprovedImageBytes(getIdentity(req), id),
        toR2: async (bytes, contentType, seed) => uploadPublic(await getR2Creds(pool), bytes, contentType, seed),
        normalize: (url) => normalizeMedia(creds, url),
      });

      // A scheduled Instagram post publishes itself, so a missing image isn't
      // something a human gets a chance to fix — Instagram rejects it outright.
      const note = publish === "scheduled" && networks.includes("instagram") && !mediaUrls.length
        ? "Instagram won't publish without an image — add one in Metricool before the scheduled time." : "";

      const payload = buildSchedulerPayload({ text: b.text || "", networks, dateTime: b.dateTime, timezone: b.timezone, mediaUrls, publish });
      const postId = await schedulePost(creds, payload);

      await logSend(pool, {
        sourceType: b.sourceType || "", sourceRef: b.sourceRef || "", text: b.text || "",
        networks: networks.join(","), imageRef: imageRefOf(b), r2Url: mediaUrls.join(" "),
        scheduledFor: b.dateTime, timezone: b.timezone, metricoolPostId: postId, status: "sent", error: "", createdBy: email,
      });
      // Pipeline bookkeeping must never turn a successful send into an error.
      if (b.contentItemId) await markSentToMetricool(pool, b.contentItemId, b.dateTime).catch((e) => req.log.warn(e));
      return { ok: true, metricoolPostId: postId, scheduledFor: b.dateTime, warnings, note, autoPublish: payload.autoPublish };
    } catch (e) {
      await logSend(pool, {
        sourceType: b.sourceType || "", sourceRef: b.sourceRef || "", text: b.text || "",
        networks: (b.networks || []).join(","), imageRef: imageRefOf(b), r2Url: mediaUrls.join(" "),
        scheduledFor: b.dateTime || "", timezone: b.timezone || "", metricoolPostId: "", status: "error",
        error: (e as Error).message, createdBy: email,
      }).catch(() => {});
      return { ok: false, error: (e as Error).message };
    }
  });
}
