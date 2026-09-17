import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { loadPermissions, requirePermission } from "../guard";
import { addEvent } from "../events";
import { getSetting } from "../settings";
import {
  completeActuals,
  getRequest,
  markReimbursed,
  setStatus,
} from "../requests";
import {
  DecisionAction,
  checkDecision,
  needsReapproval,
  statusAfterDecision,
} from "../lifecycle";

const ACTIONS: DecisionAction[] = ["approve", "reject", "request_changes"];

async function selfApprovalAllowed(): Promise<boolean> {
  return (await getSetting(pool, "allow_self_approval")) === "true";
}

export async function decisionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/requests/:id/decision", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { action?: string; comment?: string };
    const action = String(b.action ?? "") as DecisionAction;
    if (!ACTIONS.includes(action)) {
      return reply.code(400).send({ ok: false, error: "Unknown decision." });
    }

    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });

    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const comment = String(b.comment ?? "");
    const guard = checkDecision(
      found.request, identity.email, perms, action, comment, await selfApprovalAllowed()
    );
    if (!guard.ok) return reply.code(guard.status).send({ ok: false, error: guard.error });

    const status = statusAfterDecision(action);
    await setStatus(pool, Number(id), status, {
      approvalMethod: action === "approve" ? "digital" : null,
      approvedByEmail: action === "approve" ? identity.email : null,
      approvedAt: action === "approve" ? new Date().toISOString() : null,
    });
    await addEvent(pool, Number(id), status, identity, comment);
    return { ok: true, status };
  });

  // The paper path, kept so the office can transition gradually. It runs the
  // same guard as a digital approval — the only difference is how it is
  // recorded, so both eras sit in one log correctly labelled.
  app.post("/api/requests/:id/paper-approval", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { approvedOn?: string; note?: string };

    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });

    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const guard = checkDecision(
      found.request, identity.email, perms, "approve", "", await selfApprovalAllowed()
    );
    if (!guard.ok) return reply.code(guard.status).send({ ok: false, error: guard.error });

    const approvedOn = String(b.approvedOn ?? "").trim();
    await setStatus(pool, Number(id), "approved", {
      approvalMethod: "paper",
      approvedByEmail: identity.email,
      approvedAt: approvedOn ? new Date(`${approvedOn}T12:00:00Z`).toISOString() : new Date().toISOString(),
    });
    await addEvent(pool, Number(id), "approved_on_paper", identity, String(b.note ?? ""), {
      approvedOn: approvedOn || null,
    });
    return { ok: true };
  });

  // Completing an approved pre-purchase with what was actually spent.
  app.post("/api/requests/:id/actuals", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { amount?: unknown; items?: unknown };

    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });

    const r = found.request;
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const own = r.submitted_by_email.toLowerCase() === identity.email.toLowerCase();
    if (!perms.manage && !own) {
      return reply.code(403).send({ ok: false, error: "Only the submitter can complete this request." });
    }
    if (r.kind !== "pre_purchase") {
      return reply.code(409).send({ ok: false, error: "Only a pre-purchase request is completed with actuals." });
    }
    if (r.status !== "approved") {
      return reply.code(409).send({ ok: false, error: "This request has not been approved yet." });
    }

    const amount = Number(b.amount) || 0;
    const items = Array.isArray(b.items)
      ? (b.items as Array<Record<string, unknown>>).map((i) => ({
          title: String(i?.title ?? ""),
          price: Number(i?.price) || 0,
          autoType: (i?.autoType ?? null) as null,
        }))
      : found.items;

    await completeActuals(pool, Number(id), amount, items);

    const pct = Number(await getSetting(pool, "overage_tolerance_pct")) || 0.1;
    const abs = Number(await getSetting(pool, "overage_tolerance_abs")) || 25;
    if (needsReapproval(r.estimated_amount, amount, pct, abs)) {
      // Back to the approver, with both figures on the record so they can see
      // exactly what changed.
      await setStatus(pool, Number(id), "pending");
      await addEvent(pool, Number(id), "reapproval_required", identity, "", {
        estimate: r.estimated_amount,
        actual: amount,
      });
      return { ok: true, reapprovalRequired: true };
    }

    await addEvent(pool, Number(id), "actuals_completed", identity, "", {
      estimate: r.estimated_amount,
      actual: amount,
    });
    return { ok: true, reapprovalRequired: false };
  });

  app.post(
    "/api/requests/:id/reimburse",
    { preHandler: requirePermission("manage") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as { paidOn?: string; reference?: string };

      const found = await getRequest(pool, Number(id));
      if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });

      const r = found.request;
      // Church-card money was never the person's to get back.
      if (r.payment_method !== "reimbursement") {
        return reply.code(409).send({ ok: false, error: "This request is not a reimbursement." });
      }
      if (r.status !== "approved") {
        return reply.code(409).send({ ok: false, error: "This request has not been approved yet." });
      }
      if (r.kind === "pre_purchase" && !r.actuals_completed_at) {
        return reply.code(409).send({
          ok: false,
          error: "Add the actual amount and receipts before reimbursing.",
        });
      }

      const identity = getIdentity(req);
      await markReimbursed(pool, Number(id), identity.email, String(b.paidOn ?? ""), String(b.reference ?? ""));
      await addEvent(pool, Number(id), "reimbursed", identity, String(b.reference ?? ""), {
        paidOn: String(b.paidOn ?? "") || null,
      });
      return { ok: true };
    }
  );
}
