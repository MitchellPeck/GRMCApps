import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { requirePermission } from "../guard";
import { getIdentity } from "../identity";
import { mailConfig, sendViaResend } from "../mailer";
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
  mailFrom: "mail_from",
  dailyDigest: "daily_digest",
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
    const resend = String(body.resendApiKey ?? "").trim();
    if (resend) await setSetting(pool, "resend_api_key", resend);

    return { ok: true, settings: await getSettingsView(pool) };
  });

  // Sends one email straight away to whoever pressed the button, so the admin
  // finds out now — not from a silent outbox — whether the key and the from
  // address work.
  app.post("/api/settings/test-email", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const mail = await mailConfig(pool);
    if (!mail) {
      return reply.code(400).send({ ok: false, error: "Save a from address and a Resend key first." });
    }
    const to = getIdentity(req).email;
    const out = await sendViaResend(fetch, mail, {
      to,
      subject: "Expenses test email",
      body: "If you can read this, Expenses can send email.",
    });
    if (!out.ok) return reply.code(502).send({ ok: false, error: out.error });
    return { ok: true, to };
  });
}
