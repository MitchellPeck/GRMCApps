import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { loadPermissions, requirePermission } from "../guard";
import { createCard, deleteCard, listCards, updateCard } from "../cards";
import { visibleCardsFor } from "../cards-logic";

const LAST4 = /^\d{4}$/;

export async function cardRoutes(app: FastifyInstance): Promise<void> {
  // Admins see every card to manage them; everyone else sees only the cards
  // they may actually charge to. `for` lets a submitter-on-behalf list the
  // cards of the person who made the purchase.
  app.get("/api/cards", async (req) => {
    const all = await listCards(pool);
    const perms = await loadPermissions(req);
    if (perms.admin) return { ok: true, cards: all };

    const forEmail = String((req.query as { for?: string }).for ?? "").trim();
    const subject = forEmail && perms.submitForOthers ? forEmail : getIdentity(req).email;
    return { ok: true, cards: visibleCardsFor(subject, all) };
  });

  app.post("/api/cards", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      last4?: string; nickname?: string; primaryEmail?: string; additional?: string[];
    };
    const last4 = String(b.last4 ?? "").trim();
    // Only the last four are ever stored. Anything longer is very likely a full
    // card number, which must not enter the database.
    if (!LAST4.test(last4)) {
      return reply.code(400).send({ ok: false, error: "Enter exactly the last 4 digits." });
    }
    if (!String(b.nickname ?? "").trim()) {
      return reply.code(400).send({ ok: false, error: "Give the card a nickname." });
    }
    if (!String(b.primaryEmail ?? "").trim()) {
      return reply.code(400).send({ ok: false, error: "Choose a primary cardholder." });
    }
    const id = await createCard(
      pool, last4, String(b.nickname), String(b.primaryEmail),
      Array.isArray(b.additional) ? b.additional.map(String) : []
    );
    return reply.code(201).send({ ok: true, id });
  });

  app.patch("/api/cards/:id", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.last4 !== undefined && !LAST4.test(String(b.last4).trim())) {
      return reply.code(400).send({ ok: false, error: "Enter exactly the last 4 digits." });
    }
    const ok = await updateCard(pool, Number(id), {
      last4: b.last4 === undefined ? undefined : String(b.last4).trim(),
      nickname: b.nickname === undefined ? undefined : String(b.nickname).trim(),
      primary_email: b.primaryEmail === undefined ? undefined : String(b.primaryEmail),
      active: b.active as boolean | undefined,
      additional: Array.isArray(b.additional) ? (b.additional as unknown[]).map(String) : undefined,
    });
    if (!ok) return reply.code(404).send({ ok: false, error: "Card not found." });
    return { ok: true };
  });

  app.delete("/api/cards/:id", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteCard(pool, Number(id));
    if (!ok) return reply.code(404).send({ ok: false, error: "Card not found." });
    return { ok: true };
  });
}
