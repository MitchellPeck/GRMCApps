import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { loadPermissions, requirePermission } from "../guard";
import { addEvent, listEvents } from "../events";
import { listReceipts } from "../receipts";
import { getSetting } from "../settings";
import {
  ExpenseRequestInput,
  deleteRequest,
  getRequest,
  listRequests,
  saveRequest,
  updateRequest,
} from "../requests";
import {
  PaymentMethod,
  RequestKind,
  checkEdit,
  requiredFields,
  stageOf,
} from "../lifecycle";

const KINDS: RequestKind[] = ["pre_purchase", "post_purchase"];
const PAYMENTS: PaymentMethod[] = ["church_card", "reimbursement"];

function parseItems(raw: unknown): ExpenseRequestInput["items"] {
  if (!Array.isArray(raw)) return [];
  return raw.map((i) => ({
    title: String((i as { title?: unknown })?.title ?? ""),
    price: Number((i as { price?: unknown })?.price) || 0,
    autoType: ((i as { autoType?: unknown })?.autoType ?? null) as ExpenseRequestInput["items"][number]["autoType"],
  }));
}

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/requests", async () => {
    const rows = await listRequests(pool);
    return { ok: true, requests: rows.map((r) => ({ ...r, stage: stageOf(r) })) };
  });

  app.get("/api/requests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });
    return {
      ok: true,
      request: { ...found.request, stage: stageOf(found.request) },
      items: found.items,
      events: await listEvents(pool, Number(id)),
      receipts: await listReceipts(pool, Number(id)),
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

    const need = requiredFields(kind, paymentMethod);
    const cardId = b.cardId === undefined || b.cardId === null || b.cardId === "" ? null : Number(b.cardId);
    if (need.card && !cardId) {
      return reply.code(400).send({ ok: false, error: "Choose the card this was charged to." });
    }
    if (need.estimate && !(Number(b.estimatedAmount) > 0)) {
      return reply.code(400).send({ ok: false, error: "Enter an estimated amount." });
    }
    if (!String(b.approverEmail ?? "").trim()) {
      return reply.code(400).send({ ok: false, error: "Choose an approver." });
    }

    // Without submit_for_others, both name fields are forced to the signed-in
    // user regardless of what the browser sent — the UI disables them, and this
    // is what makes that real.
    const purchasedBy = perms.submitForOthers ? String(b.purchasedBy ?? "") : identity.name;
    const submittedBy = perms.submitForOthers ? String(b.submittedBy ?? "") : identity.name;
    const purchasedByEmail = perms.submitForOthers ? String(b.purchasedByEmail ?? "") : identity.email;

    const id = await saveRequest(pool, identity, {
      kind,
      paymentMethod,
      requestDate: String(b.requestDate ?? ""),
      amount: Number(b.amount) || 0,
      estimatedAmount: need.estimate ? Number(b.estimatedAmount) || 0 : null,
      reason: String(b.reason ?? ""),
      vendor: String(b.vendor ?? ""),
      chargeCode: String(b.chargeCode ?? ""),
      subChargeCode: String(b.subChargeCode ?? ""),
      cardId: need.card ? cardId : null,
      card: String(b.card ?? ""),
      purchasedBy,
      purchasedByEmail,
      submittedBy,
      approvedBy: String(b.approvedBy ?? ""),
      approverEmail: String(b.approverEmail ?? ""),
      items: parseItems(b.items),
    });

    await addEvent(pool, id, "submitted", identity, String(b.note ?? ""), {
      kind,
      paymentMethod,
    });
    return reply.code(201).send({ ok: true, id });
  });

  app.patch("/api/requests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });

    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const guard = checkEdit(found.request, identity.email, perms);
    if (!guard.ok) return reply.code(guard.status).send({ ok: false, error: guard.error });

    const b = (req.body ?? {}) as Record<string, unknown>;
    await updateRequest(pool, Number(id), {
      requestDate: b.requestDate === undefined ? undefined : String(b.requestDate),
      amount: b.amount === undefined ? undefined : Number(b.amount),
      reason: b.reason === undefined ? undefined : String(b.reason),
      vendor: b.vendor === undefined ? undefined : String(b.vendor),
      chargeCode: b.chargeCode === undefined ? undefined : String(b.chargeCode),
      subChargeCode: b.subChargeCode === undefined ? undefined : String(b.subChargeCode),
      cardId: b.cardId === undefined ? undefined : Number(b.cardId),
      approverEmail: b.approverEmail === undefined ? undefined : String(b.approverEmail),
      approvedBy: b.approvedBy === undefined ? undefined : String(b.approvedBy),
      items: b.items === undefined ? undefined : parseItems(b.items),
    });
    await addEvent(pool, Number(id), "edited", identity, String(b.note ?? ""));
    return { ok: true };
  });

  app.delete(
    "/api/requests/:id",
    { preHandler: requirePermission("manage") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = await deleteRequest(pool, Number(id));
      if (!ok) return reply.code(404).send({ ok: false, error: "Request not found." });
      return { ok: true };
    }
  );

  // Anyone who can see a request may comment on it; the thread and the audit
  // trail are the same table, so a conversation is part of the record.
  app.post("/api/requests/:id/comments", async (req, reply) => {
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
  app.get("/api/queue", async (req) => {
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    if (!perms.approve) return { ok: true, count: 0, requests: [] };

    const allowSelf = (await getSetting(pool, "allow_self_approval")) === "true";
    const rows = (await listRequests(pool)).filter((r) => {
      if (r.status !== "pending") return false;
      if (!perms.manage && r.approver_email.toLowerCase() !== identity.email.toLowerCase()) return false;
      if (!allowSelf && r.submitted_by_email.toLowerCase() === identity.email.toLowerCase()) return false;
      return true;
    });
    return { ok: true, count: rows.length, requests: rows.map((r) => ({ ...r, stage: stageOf(r) })) };
  });
}
