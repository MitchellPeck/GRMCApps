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
  allowSelfApproval: boolean;
  overageTolerancePct: number;
  overageToleranceAbs: number;
  orgName: string;
  defaultPurchasedBy: string;
  defaultCard: string;
  defaultSubmittedBy: string;
  defaultApprovedBy: string;
  hasApiKey: boolean;
  apiKeyHint: string;
}

// Never returns the key itself — only whether one is set, plus a short hint,
// matching how social-posts exposes its credentials.
export async function getSettingsView(pool: Pool): Promise<SettingsView> {
  const key = await getSetting(pool, "anthropic_api_key");
  return {
    allowSelfApproval: (await getSetting(pool, "allow_self_approval")) === "true",
    overageTolerancePct: Number(await getSetting(pool, "overage_tolerance_pct")) || 0.1,
    overageToleranceAbs: Number(await getSetting(pool, "overage_tolerance_abs")) || 25,
    orgName: await getSetting(pool, "org_name"),
    defaultPurchasedBy: await getSetting(pool, "default_purchased_by"),
    defaultCard: await getSetting(pool, "default_card"),
    defaultSubmittedBy: await getSetting(pool, "default_submitted_by"),
    defaultApprovedBy: await getSetting(pool, "default_approved_by"),
    hasApiKey: key.length > 0,
    apiKeyHint: key ? key.substring(0, 10) + "..." : "",
  };
}
