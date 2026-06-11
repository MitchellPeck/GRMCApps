import { Pool } from "pg";

export async function getSetting(pool: Pool, key: string): Promise<string> {
  const r = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return r.rows[0] ? r.rows[0].value : "";
}

export async function setSetting(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

export interface SettingsView {
  anthropicKeyHint: string;
  hasAnthropicKey: boolean;
  mailchimpServer: string;
  hasMailchimp: boolean;
  hasMetricool: boolean;
  metricoolUserId: string;
  metricoolBlogId: string;
  defaultPostTime: string;
  defaultTimezone: string;
  hasR2: boolean;
}

// Mirrors Code.gs getSettings(): never returns full keys, only a hint + flags.
export async function getSettingsView(pool: Pool): Promise<SettingsView> {
  const ak = await getSetting(pool, "anthropic_api_key");
  const mk = await getSetting(pool, "mailchimp_api_key");
  const server = await getSetting(pool, "mailchimp_server");
  const mcToken = await getSetting(pool, "metricool_token");
  const mcUser = await getSetting(pool, "metricool_user_id");
  const r2Key = await getSetting(pool, "r2_access_key_id");
  const r2Bucket = await getSetting(pool, "r2_bucket");
  return {
    anthropicKeyHint: ak ? ak.substring(0, 10) + "..." : "",
    hasAnthropicKey: ak.length > 0,
    mailchimpServer: server,
    hasMailchimp: !!(mk && server),
    hasMetricool: !!(mcToken && mcUser),
    metricoolUserId: mcUser,
    metricoolBlogId: await getSetting(pool, "metricool_blog_id"),
    defaultPostTime: (await getSetting(pool, "default_post_time")) || "09:00",
    defaultTimezone: (await getSetting(pool, "default_timezone")) || "America/New_York",
    hasR2: !!(r2Key && r2Bucket),
  };
}
