import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { requirePermission } from "../guard";
import { getSettingsView, setSetting } from "../settings";

const TEXT_KEYS: Record<string, string> = {
  orgName: "org_name",
  defaultPurchasedBy: "default_purchased_by",
  defaultCard: "default_card",
  defaultSubmittedBy: "default_submitted_by",
  defaultApprovedBy: "default_approved_by",
  allowSelfApproval: "allow_self_approval",
  overageTolerancePct: "overage_tolerance_pct",
  overageToleranceAbs: "overage_tolerance_abs",
};

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Readable by anyone with app access: it carries no secret (the API key is
  // never returned, only whether one exists), and the form needs the defaults
  // and the self-approval rule to render correctly for everyone.
  app.get("/api/settings", async () => ({ ok: true, settings: await getSettingsView(pool) }));

  app.put("/api/settings", { preHandler: requirePermission("admin") }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    for (const [field, key] of Object.entries(TEXT_KEYS)) {
      if (body[field] !== undefined) await setSetting(pool, key, String(body[field]).trim());
    }

    // An empty key field means "leave it alone", so saving the other settings
    // can never wipe a stored credential.
    const key = String(body.anthropicApiKey ?? "").trim();
    if (key) await setSetting(pool, "anthropic_api_key", key);

    return { ok: true, settings: await getSettingsView(pool) };
  });
}
