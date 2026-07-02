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
}

// Never returns full keys, only a hint + flags.
export async function getSettingsView(pool: Pool): Promise<SettingsView> {
  const ak = await getSetting(pool, "anthropic_api_key");
  return {
    anthropicKeyHint: ak ? ak.substring(0, 10) + "..." : "",
    hasAnthropicKey: ak.length > 0,
  };
}
