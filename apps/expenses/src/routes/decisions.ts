import { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { Identity } from "../identity";
import type { Permissions } from "../permissions";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { loadPermissions, rejectBadIds } from "../guard";
import { addEvent } from "../events";
import { getTolerances, selfApprovalAllowed } from "../settings";
import {
  FoundRequest,
  approveRequest,
  completeActuals,
  markReimbursed,
  returnForReapproval,
  setStatus,
} from "../requests";
import {
  DecisionAction,
  checkActuals,
  checkDecision,
  checkPaperApproval,
  checkReimburse,
  needsReapproval,
  statusAfterDecision,
} from "../lifecycle";
import { isIsoDate, parseMoney, todayIso } from "../validate";
import { Refusal, checkVersion, mutate } from "./requests";

const ACTIONS: DecisionAction[] = ["approve", "reject", "request_changes"];

// A date someone typed for something that already happened.
export function pastDate(raw: unknown, what: string): string {
  const s = String(raw ?? "").trim();
  if (!isIsoDate(s)) throw new Refusal(400, `Enter the date ${what}.`);
  if (s > todayIso()) throw new Refusal(400, `The date ${what} can't be in the future.`);
  return s;
}

export async function decisionRoutes(app: FastifyInstance): Promise<void> {
  rejectBadIds(app);

  app.post("/api/requests/:id/decision", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { action?: string; comment?: string; version?: unknown };
    const action = String(b.action ?? "") as DecisionAction;
    if (!ACTIONS.includes(action)) {
      return reply.code(400).send({ ok: false, error: "Unknown decision." });
    }
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const comment = String(b.comment ?? "").trim();
    const allowSelf = await selfApprovalAllowed(pool);

    return mutate(reply, Number(id), async (db, found) => {
      const guard = checkDecision(found.request, identity.email, perms, action, comment, allowSelf);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);
      // After the rules, so "already decided" reads as that and not as stale.
      checkVersion(found, b.version, true);

      const status = statusAfterDecision(action);
      if (action === "approve") {
        await approveRequest(db, Number(id), {
          method: "digital", byEmail: identity.email, at: new Date().toISOString(),
        });
      } else {
        await setStatus(db, Number(id), status);
      }
      await addEvent(db, Number(id), status, identity, comment);
      return { ok: true, status };
    });
  });

  // The paper path, kept so the office can transition gradually. It runs the
  // same guard as a digital approval — the only difference is how it is
  // recorded, so both eras sit in one log correctly labelled.
  app.post("/api/requests/:id/paper-approval", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { approvedOn?: string; note?: string; version?: unknown };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const allowSelf = await selfApprovalAllowed(pool);

    return mutate(reply, Number(id), async (db, found) => {
      const guard = checkPaperApproval(found.request, identity.email, perms, allowSelf);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);
      checkVersion(found, b.version, true);
      const approvedOn = pastDate(b.approvedOn, "it was approved on paper");

      // The signature is the approver's even when the office types it in; the
      // event's actor records who did the typing.
      const assigned = found.request.approver_email.trim().toLowerCase();
      const signer = !assigned || assigned === identity.email.trim().toLowerCase()
        ? identity.email
        : found.request.approver_email;
      await approveRequest(db, Number(id), {
        method: "paper", byEmail: signer, at: `${approvedOn}T12:00:00Z`,
      });
      await addEvent(db, Number(id), "approved_on_paper", identity, String(b.note ?? "").trim(), {
        approvedOn, signedBy: signer,
      });
      return { ok: true };
    });
  });

  // Completing an approved pre-purchase with what was actually spent.
  app.post("/api/requests/:id/actuals", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { amount?: unknown; items?: unknown; version?: unknown };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const tol = await getTolerances(pool);

    return mutate(reply, Number(id), async (db, found) => {
      checkVersion(found, b.version);
      const r = found.request;
      const guard = checkActuals(r, identity.email, perms);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);

      const amount = parseMoney(b.amount);
      if (amount === null || amount <= 0) throw new Refusal(400, "Enter what it actually cost.");
      // No new items means the estimate's lines no longer describe the
      // purchase, so they are replaced by one line for the actual amount.
      const items = Array.isArray(b.items)
        ? (b.items as Array<Record<string, unknown>>).map((i) => ({
            title: String(i?.title ?? ""),
            price: Number(i?.price) || 0,
            autoType: null,
          }))
        : [{ title: r.reason || "Actual cost", price: amount, autoType: null }];

      await completeActuals(db, Number(id), amount, items);

      const approved = r.approved_amount ?? r.estimated_amount;
      if (needsReapproval(approved, amount, tol.pct, tol.abs)) {
        // Back to the approver, with both figures on the record so they can see
        // exactly what changed.
        await returnForReapproval(db, Number(id));
        await addEvent(db, Number(id), "reapproval_required", identity, "", {
          estimate: approved,
          actual: amount,
        });
        return { ok: true, reapprovalRequired: true };
      }

      await addEvent(db, Number(id), "actuals_completed", identity, "", {
        estimate: approved,
        actual: amount,
      });
      return { ok: true, reapprovalRequired: false };
    });
  });

  app.post("/api/requests/:id/reimburse", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { paidOn?: string; reference?: string; version?: unknown };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);

    return mutate(reply, Number(id), async (db, found) => {
      checkVersion(found, b.version);
      await reimburse(db, found, identity, perms, b.paidOn, b.reference);
      return { ok: true };
    });
  });
}

// One reimbursement, inside the caller's transaction. Shared by the single
// button and the office's pay run.
export async function reimburse(
  db: PoolClient,
  found: FoundRequest,
  identity: Identity,
  perms: Permissions,
  rawPaidOn: unknown,
  rawReference: unknown
): Promise<void> {
  const guard = checkReimburse(found.request, identity.email, perms);
  if (!guard.ok) throw new Refusal(guard.status, guard.error);
  const paidOn = pastDate(rawPaidOn, "it was paid");
  const reference = String(rawReference ?? "").trim();
  await markReimbursed(db, found.request.id, identity.email, paidOn, reference);
  await addEvent(db, found.request.id, "reimbursed", identity, reference, {
    paidOn,
    amount: found.request.amount,
  });
}
