import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import {
  ExpenseRequestInput,
  deleteRequest,
  getRequest,
  listRequests,
  saveRequest,
} from "../requests";

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/requests", async () => ({ ok: true, requests: await listRequests(pool) }));

  app.get("/api/requests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await getRequest(pool, Number(id));
    if (!found) return reply.code(404).send({ ok: false, error: "Request not found." });
    return { ok: true, ...found };
  });

  app.post("/api/requests", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ExpenseRequestInput>;
    const items = Array.isArray(body.items) ? body.items : [];
    const id = await saveRequest(pool, getIdentity(req), {
      requestDate: String(body.requestDate ?? ""),
      amount: Number(body.amount) || 0,
      reason: String(body.reason ?? ""),
      vendor: String(body.vendor ?? ""),
      chargeCode: String(body.chargeCode ?? ""),
      subChargeCode: String(body.subChargeCode ?? ""),
      purchasedBy: String(body.purchasedBy ?? ""),
      card: String(body.card ?? ""),
      submittedBy: String(body.submittedBy ?? ""),
      approvedBy: String(body.approvedBy ?? ""),
      items: items.map((i) => ({
        title: String(i?.title ?? ""),
        price: Number(i?.price) || 0,
        autoType: i?.autoType ?? null,
      })),
    });
    return reply.code(201).send({ ok: true, id });
  });

  app.delete("/api/requests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteRequest(pool, Number(id));
    if (!ok) return reply.code(404).send({ ok: false, error: "Request not found." });
    return { ok: true };
  });
}
