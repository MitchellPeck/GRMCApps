import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { getSettingsView } from "../settings";
import { getMetricoolCreds, listBrands, normalizeMedia, schedulePost, buildSchedulerPayload, charWarnings } from "../metricool";
import { logSend } from "../metricool-sends";
import { listApprovedImages } from "../approvals-client";

interface SendBody {
  text: string; networks: string[]; dateTime: string; timezone: string;
  imageUrl?: string; approvedImageId?: string; sourceType?: string; sourceRef?: string;
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

  app.post("/api/metricool/send", async (req) => {
    const b = (req.body ?? {}) as SendBody;
    const email = getIdentity(req).email;
    try {
      const creds = await getMetricoolCreds(pool);
      const networks = Array.isArray(b.networks) ? b.networks : [];
      const warnings = charWarnings(b.text || "", networks);

      let mediaUrl = "";
      if (b.imageUrl && b.imageUrl.trim()) mediaUrl = await normalizeMedia(creds, b.imageUrl.trim());

      const note = networks.includes("instagram") && !mediaUrl
        ? "Instagram needs an image — add it in Metricool before publishing." : "";

      const payload = buildSchedulerPayload({ text: b.text || "", networks, dateTime: b.dateTime, timezone: b.timezone, mediaUrl });
      const postId = await schedulePost(creds, payload);

      await logSend(pool, {
        sourceType: b.sourceType || "", sourceRef: b.sourceRef || "", text: b.text || "",
        networks: networks.join(","), imageRef: b.approvedImageId || b.imageUrl || "", r2Url: mediaUrl,
        scheduledFor: b.dateTime, timezone: b.timezone, metricoolPostId: postId, status: "sent", error: "", createdBy: email,
      });
      return { ok: true, metricoolPostId: postId, scheduledFor: b.dateTime, warnings, note };
    } catch (e) {
      await logSend(pool, {
        sourceType: b.sourceType || "", sourceRef: b.sourceRef || "", text: b.text || "",
        networks: (b.networks || []).join(","), imageRef: b.approvedImageId || b.imageUrl || "", r2Url: "",
        scheduledFor: b.dateTime || "", timezone: b.timezone || "", metricoolPostId: "", status: "error",
        error: (e as Error).message, createdBy: email,
      }).catch(() => {});
      return { ok: false, error: (e as Error).message };
    }
  });
}
