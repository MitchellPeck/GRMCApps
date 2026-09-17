import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getSettingsView, setSetting } from "../settings";

const NAME_KEYS: Record<string, string> = {
  orgName: "org_name",
  defaultPurchasedBy: "default_purchased_by",
  defaultCard: "default_card",
  defaultSubmittedBy: "default_submitted_by",
  defaultApprovedBy: "default_approved_by",
};

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => ({ ok: true, settings: await getSettingsView(pool) }));

  app.put("/api/settings", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    for (const [field, key] of Object.entries(NAME_KEYS)) {
      if (body[field] !== undefined) await setSetting(pool, key, String(body[field]).trim());
    }

    // An empty key field means "leave it alone", so saving the other settings
    // can never wipe a stored credential.
    const key = String(body.anthropicApiKey ?? "").trim();
    if (key) await setSetting(pool, "anthropic_api_key", key);

    return { ok: true, settings: await getSettingsView(pool) };
  });
}
