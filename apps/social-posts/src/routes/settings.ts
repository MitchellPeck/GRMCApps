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
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
