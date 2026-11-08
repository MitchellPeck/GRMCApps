import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getSettingsView, setSetting } from "../settings";

interface SaveBody {
  anthropicKey?: string;
  mailchimpKey?: string;
  mailchimpServer?: string;
  metricoolToken?: string;
  metricoolUserId?: string;
  metricoolBlogId?: string;
  defaultPostTime?: string;
  defaultTimezone?: string;
  r2AccountId?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2Bucket?: string;
  r2PublicBaseUrl?: string;
  buzzsproutToken?: string;
  buzzsproutPodcastId?: string;
  buzzsproutPodcastName?: string;
  houseVoice?: string;
  resendKey?: string;
  mailFrom?: string;
  publicBaseUrl?: string;
  gnSendDow?: number | string | null;
  gnCreateAt?: string;
  gnRemindAt?: string;
  gnDeadlineAt?: string;
}

function parseSchedule(s: SaveBody): string | { dow?: string; times: Record<string, string | undefined> } {
  let dow: string | undefined;
  if (s.gnSendDow !== undefined && s.gnSendDow !== "") {
    const raw = s.gnSendDow === null ? "" : String(s.gnSendDow).trim();
    const d = Number(raw);
    if (raw === "" || !Number.isInteger(d) || d < 0 || d > 6) return "Send day must be 0 (Sunday) to 6 (Saturday).";
    dow = String(d);
  }
  const times: Record<string, string | undefined> = {};
  for (const [field, key] of [["gnCreateAt", "gn_create_at"], ["gnRemindAt", "gn_remind_at"], ["gnDeadlineAt", "gn_deadline_at"]] as const) {
    const v = s[field]?.trim();
    if (!v) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return "Times must look like 18:00.";
    times[key] = v;
  }
  return { dow, times };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => {
    try {
      return { ok: true, ...(await getSettingsView(pool)) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.post("/api/settings", async (req) => {
    try {
      const s = (req.body ?? {}) as SaveBody;
      // Validate every schedule field before any write, so a bad request saves nothing.
      const schedule = parseSchedule(s);
      if (typeof schedule === "string") return { ok: false, error: schedule };
      if (s.anthropicKey && s.anthropicKey.trim())
        await setSetting(pool, "anthropic_api_key", s.anthropicKey.trim());
      if (s.mailchimpKey && s.mailchimpKey.trim())
        await setSetting(pool, "mailchimp_api_key", s.mailchimpKey.trim());
      if (s.mailchimpServer && s.mailchimpServer.trim())
        await setSetting(pool, "mailchimp_server", s.mailchimpServer.trim());
      if (s.metricoolToken && s.metricoolToken.trim())
        await setSetting(pool, "metricool_token", s.metricoolToken.trim());
      if (s.metricoolUserId && s.metricoolUserId.trim())
        await setSetting(pool, "metricool_user_id", s.metricoolUserId.trim());
      if (s.metricoolBlogId && s.metricoolBlogId.trim())
        await setSetting(pool, "metricool_blog_id", s.metricoolBlogId.trim());
      if (s.defaultPostTime && s.defaultPostTime.trim())
        await setSetting(pool, "default_post_time", s.defaultPostTime.trim());
      if (s.defaultTimezone && s.defaultTimezone.trim())
        await setSetting(pool, "default_timezone", s.defaultTimezone.trim());
      if (s.r2AccountId && s.r2AccountId.trim())
        await setSetting(pool, "r2_account_id", s.r2AccountId.trim());
      if (s.r2AccessKeyId && s.r2AccessKeyId.trim())
        await setSetting(pool, "r2_access_key_id", s.r2AccessKeyId.trim());
      if (s.r2SecretAccessKey && s.r2SecretAccessKey.trim())
        await setSetting(pool, "r2_secret_access_key", s.r2SecretAccessKey.trim());
      if (s.r2Bucket && s.r2Bucket.trim())
        await setSetting(pool, "r2_bucket", s.r2Bucket.trim());
      if (s.r2PublicBaseUrl && s.r2PublicBaseUrl.trim())
        await setSetting(pool, "r2_public_base_url", s.r2PublicBaseUrl.trim());
      if (s.buzzsproutToken && s.buzzsproutToken.trim())
        await setSetting(pool, "buzzsprout_api_token", s.buzzsproutToken.trim());
      if (s.buzzsproutPodcastId && s.buzzsproutPodcastId.trim())
        await setSetting(pool, "buzzsprout_podcast_id", s.buzzsproutPodcastId.trim());
      if (s.buzzsproutPodcastName && s.buzzsproutPodcastName.trim())
        await setSetting(pool, "buzzsprout_podcast_name", s.buzzsproutPodcastName.trim());
      if (s.houseVoice && s.houseVoice.trim())
        await setSetting(pool, "house_voice", s.houseVoice.trim());
      if (s.resendKey && s.resendKey.trim())
        await setSetting(pool, "resend_api_key", s.resendKey.trim());
      if (s.mailFrom && s.mailFrom.trim())
        await setSetting(pool, "mail_from", s.mailFrom.trim());
      if (s.publicBaseUrl && s.publicBaseUrl.trim())
        await setSetting(pool, "public_base_url", s.publicBaseUrl.trim().replace(/\/+$/, ""));
      for (const [key, v] of Object.entries(schedule.times)) if (v !== undefined) await setSetting(pool, key, v);
      if (schedule.dow !== undefined) await setSetting(pool, "gn_send_dow", schedule.dow);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
