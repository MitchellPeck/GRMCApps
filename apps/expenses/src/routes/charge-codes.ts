import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { rejectBadIds, requirePermission } from "../guard";
import {
  chargeCodeTree,
  createChargeCode,
  chargeCodeUsage,
  deleteChargeCode,
  listChargeCodes,
  updateChargeCode,
} from "../charge-codes";

export async function chargeCodeRoutes(app: FastifyInstance): Promise<void> {
  rejectBadIds(app);

  app.get("/api/charge-codes", async () => ({
    ok: true,
    codes: chargeCodeTree(await listChargeCodes(pool)),
  }));

  app.post("/api/charge-codes", { preHandler: requirePermission("manage") }, async (req, reply) => {
    const body = (req.body ?? {}) as { code?: string; label?: string; parentId?: number | null; glAccount?: string };
    const code = String(body.code ?? "").trim();
    const label = String(body.label ?? "").trim();
    if (!code || !label) {
      return reply.code(400).send({ ok: false, error: "A code and a label are both required." });
    }
    try {
      const id = await createChargeCode(pool, code, label, body.parentId ?? null, String(body.glAccount ?? ""));
      return { ok: true, id };
    } catch {
      return reply.code(409).send({ ok: false, error: "That code already exists here." });
    }
  });

  app.patch("/api/charge-codes/:id", { preHandler: requirePermission("manage") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { code?: string; label?: string; active?: boolean; glAccount?: string };
    const ok = await updateChargeCode(pool, Number(id), body);
    if (!ok) return reply.code(404).send({ ok: false, error: "Charge code not found." });
    return { ok: true };
  });

  app.delete("/api/charge-codes/:id", { preHandler: requirePermission("manage") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const used = await chargeCodeUsage(pool, Number(id));
    if (used > 0) {
      return reply.code(409).send({
        ok: false,
        error: `${used} request${used === 1 ? " uses" : "s use"} this code, so it can't be deleted. Turn it off instead.`,
      });
    }
    // Sub-codes cascade with the parent.
    const ok = await deleteChargeCode(pool, Number(id));
    if (!ok) return reply.code(404).send({ ok: false, error: "Charge code not found." });
    return { ok: true };
  });
}
