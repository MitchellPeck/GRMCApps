import { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { loadPermissions, rejectBadIds, requireMember, requirePermission } from "../guard";
import { addEvent, listEvents } from "../events";
import { listReceipts } from "../receipts";
import { getTolerances, selfApprovalAllowed } from "../settings";
import { listApprovers } from "../app-users";
import { listCards } from "../cards";
import { visibleCardsFor } from "../cards-logic";
import {
  ExpenseRequestInput,
  FoundRequest,
  deleteRequest,
  getRequest,
  listRequests,
  returnForReapproval,
  saveRequest,
  setStatus,
  updateRequest,
  voidRequest,
  withRequest,
} from "../requests";
import {
  PaymentMethod,
  RequestKind,
  allowedActions,
  checkDelete,
  checkEdit,
  checkResubmit,
  checkVoid,
  describeEdit,
  reapprovalAfterEdit,
  stageOf,
} from "../lifecycle";
import { itemsMatch, parseMoney, todayIso, validateSubmission, isIsoDate } from "../validate";

const KINDS: RequestKind[] = ["pre_purchase", "post_purchase"];
const PAYMENTS: PaymentMethod[] = ["church_card", "reimbursement"];

export const STALE_ERROR = "This request changed since you opened it. Reload to see the latest.";

function parseItems(raw: unknown): ExpenseRequestInput["items"] {
  if (!Array.isArray(raw)) return [];
  return raw.map((i) => ({
    title: String((i as { title?: unknown })?.title ?? ""),
    price: Math.round((Number((i as { price?: unknown })?.price) || 0) * 100) / 100,
    autoType: ((i as { autoType?: unknown })?.autoType ?? null) as ExpenseRequestInput["items"][number]["autoType"],
  }));
}

// A thrown Refusal ends a transaction with a rollback and becomes the reply.
export class Refusal extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

// Optimistic concurrency: a client that says which version it saw is refused
// if the row has moved since. `required` is for decisions — approving numbers
// you never saw is the one thing this must never allow.
export function checkVersion(found: FoundRequest, sent: unknown, required = false): void {
  if (sent === undefined || sent === null || sent === "") {
    if (required) throw new Refusal(409, STALE_ERROR, { stale: true });
    return;
  }
  if (Number(sent) !== found.request.version) throw new Refusal(409, STALE_ERROR, { stale: true });
}

// Runs fn inside withRequest and turns every outcome into a reply.
export async function mutate(
  reply: FastifyReply,
  id: number,
  fn: Parameters<typeof withRequest>[2]
): Promise<unknown> {
  try {
    const out = await withRequest(pool, id, fn);
    if (out === null) return reply.code(404).send({ ok: false, error: "Request not found." });
    return out;
  } catch (err) {
    if (err instanceof Refusal) {
      return reply.code(err.status).send({ ok: false, error: err.message, ...err.extra });
    }
    throw err;
  }
}

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  rejectBadIds(app);

  app.get("/api/requests", { preHandler: requireMember }, async () => {
    const rows = await listRequests(pool);
    return { ok: true, requests: rows.map((r) => ({ ...r, stage: stageOf(r) })) };
  });

  app.get("/api/requests/:id", { preHandler: requireMember }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });
    const perms = await loadPermissions(req);
    return {
      ok: true,
      request: { ...found.request, stage: stageOf(found.request) },
      items: found.items,
      events: await listEvents(pool, Number(id)),
      receipts: await listReceipts(pool, Number(id)),
      allowed: allowedActions(found.request, getIdentity(req).email, perms, await selfApprovalAllowed(pool)),
    };
  });

  app.post("/api/requests", { preHandler: requirePermission("submit") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);

    const kind = String(b.kind ?? "") as RequestKind;
    const paymentMethod = String(b.paymentMethod ?? "") as PaymentMethod;
    if (!KINDS.includes(kind) || !PAYMENTS.includes(paymentMethod)) {
      return reply.code(400).send({ ok: false, error: "Choose a request type and payment method." });
    }

    // Without submit_for_others, both name fields are forced to the signed-in
    // user regardless of what the browser sent — the UI disables them, and this
    // is what makes that real.
    const purchasedBy = perms.submitForOthers ? String(b.purchasedBy ?? "") : identity.name;
    const submittedBy = perms.submitForOthers ? String(b.submittedBy ?? "") : identity.name;
    const purchasedByEmail = (perms.submitForOthers ? String(b.purchasedByEmail ?? "") : identity.email)
      .trim().toLowerCase();

    const isPre = kind === "pre_purchase";
    const amount = isPre ? 0 : parseMoney(b.amount);
    const estimatedAmount = isPre ? parseMoney(b.estimatedAmount) : null;
    if (amount === null) return reply.code(400).send({ ok: false, error: "Enter the amount that was spent." });

    const cardId = b.cardId === undefined || b.cardId === null || b.cardId === "" ? null : Number(b.cardId);
    const items = parseItems(b.items);
    const approverEmail = String(b.approverEmail ?? "").trim().toLowerCase();
    const cardSubject = purchasedByEmail || identity.email;

    const problem = validateSubmission(
      {
        kind, paymentMethod, amount, estimatedAmount, items, cardId, approverEmail, purchasedByEmail,
        requestDate: String(b.requestDate ?? ""),
        reason: String(b.reason ?? ""),
      },
      {
        today: todayIso(),
        actorEmail: identity.email,
        approverEmails: (await listApprovers(pool)).map((a) => a.email),
        allowSelfApproval: await selfApprovalAllowed(pool),
        cardIdsForPurchaser: visibleCardsFor(cardSubject, await listCards(pool))
          .filter((c) => c.active)
          .map((c) => c.id),
      }
    );
    if (problem) return reply.code(400).send({ ok: false, error: problem });

    const id = await saveRequest(pool, identity, {
      kind,
      paymentMethod,
      requestDate: String(b.requestDate),
      amount,
      estimatedAmount,
      reason: String(b.reason ?? "").trim(),
      vendor: String(b.vendor ?? ""),
      chargeCode: String(b.chargeCode ?? ""),
      subChargeCode: String(b.subChargeCode ?? ""),
      cardId: paymentMethod === "church_card" ? cardId : null,
      card: String(b.card ?? ""),
      purchasedBy,
      purchasedByEmail,
      submittedBy,
      approvedBy: String(b.approvedBy ?? ""),
      approverEmail,
      items,
    });

    await addEvent(pool, id, "submitted", identity, String(b.note ?? ""), {
      kind,
      paymentMethod,
    });
    return reply.code(201).send({ ok: true, id });
  });

  app.patch("/api/requests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const tol = await getTolerances(pool);

    return mutate(reply, Number(id), async (db, found) => {
      checkVersion(found, b.version);
      const guard = checkEdit(found.request, identity.email, perms);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);
      const before = found.request;

      const money = (v: unknown, label: string) => {
        if (v === undefined) return undefined;
        const n = parseMoney(v);
        if (n === null) throw new Refusal(400, `Enter a valid ${label}.`);
        return n;
      };
      if (b.requestDate !== undefined && !isIsoDate(String(b.requestDate))) {
        throw new Refusal(400, "Enter the date of the purchase.");
      }
      if (b.reason !== undefined && !String(b.reason).trim()) {
        throw new Refusal(400, "Say what this was for.");
      }
      // The estimate is what an approver is asked to agree to, so it can move
      // only while the request is still waiting on them.
      const undecided = before.status === "pending" || before.status === "changes_requested";
      if (b.estimatedAmount !== undefined && !(before.kind === "pre_purchase" && undecided)) {
        throw new Refusal(409, "The estimate can only change before the request is approved.");
      }
      // An empty card means "leave it", not "clear it" — church-card spending
      // always has a card.
      const cardId = b.cardId === undefined || b.cardId === null || b.cardId === "" ? undefined : Number(b.cardId);

      const patch: Partial<ExpenseRequestInput> = {
        requestDate: b.requestDate === undefined ? undefined : String(b.requestDate),
        amount: money(b.amount, "amount"),
        estimatedAmount: money(b.estimatedAmount, "estimate"),
        reason: b.reason === undefined ? undefined : String(b.reason).trim(),
        vendor: b.vendor === undefined ? undefined : String(b.vendor),
        chargeCode: b.chargeCode === undefined ? undefined : String(b.chargeCode),
        subChargeCode: b.subChargeCode === undefined ? undefined : String(b.subChargeCode),
        cardId,
        approverEmail: b.approverEmail === undefined ? undefined : String(b.approverEmail).trim().toLowerCase(),
        approvedBy: b.approvedBy === undefined ? undefined : String(b.approvedBy),
        items: b.items === undefined ? undefined : parseItems(b.items),
      };
      if (patch.estimatedAmount !== undefined && !((patch.estimatedAmount ?? 0) > 0)) {
        throw new Refusal(400, "Enter an estimated amount.");
      }

      if (patch.cardId !== undefined) {
        const subject = before.purchased_by_email || before.submitted_by_email;
        const usable = visibleCardsFor(subject, await listCards(db)).filter((c) => c.active);
        if (!usable.some((c) => c.id === patch.cardId)) {
          throw new Refusal(400, "That card isn't one the purchaser can use. Choose another.");
        }
      }
      if (patch.approverEmail !== undefined) {
        const approvers = (await listApprovers(pool)).map((a) => a.email);
        if (!approvers.includes(patch.approverEmail)) {
          throw new Refusal(400, "That person can't approve expenses. Choose someone from the list.");
        }
        if (!(await selfApprovalAllowed(pool)) &&
            [before.submitted_by_email, before.purchased_by_email].includes(patch.approverEmail)) {
          throw new Refusal(400, "The approver can't be the person who submitted or bought it.");
        }
      }

      const amount = patch.amount ?? before.amount;
      const items = patch.items ?? found.items;
      const isPreWithoutActuals = before.kind === "pre_purchase" && !before.actuals_completed_at;
      if (!isPreWithoutActuals && items.length && (patch.items || patch.amount !== undefined) &&
          !itemsMatch(items, amount)) {
        throw new Refusal(400, "The line items don't add up to the amount. Fix one or the other.");
      }

      // The stored row and the patch spell the same fields differently, so the
      // previous values are mapped into the patch's vocabulary to be compared.
      const changes = describeEdit(
        {
          requestDate: before.request_date,
          amount: before.amount,
          estimatedAmount: before.estimated_amount,
          reason: before.reason,
          vendor: before.vendor,
          chargeCode: before.charge_code,
          subChargeCode: before.sub_charge_code,
          cardId: before.card_id,
          approverEmail: before.approver_email,
          approvedBy: before.approved_by,
          items: found.items,
        },
        patch as Record<string, unknown>
      );

      let version = await updateRequest(db, Number(id), patch);
      await addEvent(db, Number(id), "edited", identity, String(b.note ?? ""), { changes });

      // Correcting an approved total is normally reconciliation — the card was
      // charged $118.42, not the $115 that was approved. A correction past the
      // overage tolerance is a different thing, and goes back to the approver.
      const approved = before.approved_amount ?? before.amount;
      if (reapprovalAfterEdit(before.status, approved, amount, tol.pct, tol.abs)) {
        await returnForReapproval(db, Number(id));
        version += 1;
        await addEvent(db, Number(id), "reapproval_required", identity, "", {
          approvedAmount: approved,
          amount,
        });
        return { ok: true, reapprovalRequired: true, version };
      }
      return { ok: true, reapprovalRequired: false, version };
    });
  });

  // The way out of "changes requested": the owner has made the changes (or
  // answered in the comment) and the approver gets it back in their queue.
  app.post("/api/requests/:id/resubmit", async (req, reply) => {
    const { id } = req.params as { id: string };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const b = (req.body ?? {}) as Record<string, unknown>;

    return mutate(reply, Number(id), async (db, found) => {
      checkVersion(found, b.version);
      const guard = checkResubmit(found.request, identity.email, perms);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);
      await setStatus(db, Number(id), "pending");
      await addEvent(db, Number(id), "resubmitted", identity, String(b.comment ?? "").trim());
      return { ok: true, status: "pending" };
    });
  });

  // Deleting is for requests nothing has been decided on; withdrawing is for
  // an approved purchase that never happened. See checkDelete.
  app.delete("/api/requests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);

    return mutate(reply, Number(id), async (db, found) => {
      const guard = checkDelete(found.request, identity.email, perms);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);
      if (guard.mode === "withdraw") {
        await setStatus(db, Number(id), "withdrawn");
        await addEvent(db, Number(id), "withdrawn", identity);
        return { ok: true, mode: "withdraw" };
      }
      await deleteRequest(db, Number(id));
      return { ok: true, mode: "hard" };
    });
  });

  // The office's way to take a decided request off the books — a duplicate, a
  // test, a charge that was refunded — while keeping it and why on the record.
  app.post("/api/requests/:id/void", async (req, reply) => {
    const { id } = req.params as { id: string };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const reason = String(b.reason ?? "").trim();

    return mutate(reply, Number(id), async (db, found) => {
      checkVersion(found, b.version);
      const guard = checkVoid(found.request, perms, reason);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);
      await voidRequest(db, Number(id), identity.email, reason);
      await addEvent(db, Number(id), "voided", identity, reason, { previousStatus: found.request.status });
      return { ok: true, status: "voided" };
    });
  });

  // Anyone who can see a request may comment on it; the thread and the audit
  // trail are the same table, so a conversation is part of the record.
  app.post("/api/requests/:id/comments", { preHandler: requireMember }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const comment = String((req.body as { comment?: unknown })?.comment ?? "").trim();
    if (!comment) return reply.code(400).send({ ok: false, error: "Write a comment first." });

    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });

    await addEvent(pool, Number(id), "comment", getIdentity(req), comment);
    return { ok: true };
  });

  // Pending requests this user can actually act on. Their own are excluded
  // unless self-approval is allowed, because they could not decide them anyway.
  app.get("/api/queue", { preHandler: requireMember }, async (req) => {
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    if (!perms.approve) return { ok: true, count: 0, requests: [] };

    const me = identity.email.toLowerCase();
    const allowSelf = await selfApprovalAllowed(pool);
    const rows = (await listRequests(pool)).filter((r) => {
      if (r.status !== "pending") return false;
      if (!perms.manage && r.approver_email.toLowerCase() !== me) return false;
      if (!allowSelf && (r.submitted_by_email.toLowerCase() === me || r.purchased_by_email.toLowerCase() === me)) {
        return false;
      }
      return true;
    });
    return { ok: true, count: rows.length, requests: rows.map((r) => ({ ...r, stage: stageOf(r) })) };
  });
}
