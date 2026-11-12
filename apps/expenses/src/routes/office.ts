import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { loadPermissions, rejectBadIds, requirePermission } from "../guard";
import { addEvent } from "../events";
import { listApprovers } from "../app-users";
import { mailConfig } from "../mailer";
import { selfApprovalAllowed } from "../settings";
import { withRequest } from "../requests";
import { ReminderReason, checkNewApprover, checkReassign, checkRemind } from "../lifecycle";
import { Refusal, checkVersion, mutate } from "./requests";
import { pastDate, reimburse } from "./decisions";

// One reminder of each kind per request per this many hours, so a double-click or an eager
// week does not fill someone's inbox.
export const REMIND_GAP_HOURS = 12;
const MAX_PAY_RUN = 100;

export async function officeRoutes(app: FastifyInstance): Promise<void> {
  rejectBadIds(app);

  // Emails whoever the request is waiting on. Recorded as an event so the
  // timeline shows who was chased and when.
  app.post("/api/requests/:id/remind", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { comment?: string; reason?: string };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);

    return mutate(reply, Number(id), async (db, found) => {
      const wanted = b.reason ? (String(b.reason) as ReminderReason) : undefined;
      const guard = checkRemind(found.request, identity.email, perms, wanted);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);
      if (!(await mailConfig(db))) {
        throw new Refusal(409, "Email is not set up yet, so a reminder can't be sent.");
      }
      const recent = await db.query(
        `SELECT 1 FROM request_events
          WHERE request_id = $1 AND type = 'reminded' AND meta->>'reason' = $3
            AND created_at > now() - make_interval(hours => $2::int)`,
        [Number(id), REMIND_GAP_HOURS, guard.reason]
      );
      if (recent.rowCount) {
        throw new Refusal(429, `A reminder went out less than ${REMIND_GAP_HOURS} hours ago.`);
      }
      await addEvent(db, Number(id), "reminded", identity, String(b.comment ?? "").trim(), {
        reason: guard.reason,
      });
      return { ok: true, reason: guard.reason };
    });
  });

  app.post("/api/requests/:id/reassign", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { approverEmail?: string; comment?: string; version?: unknown };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const to = String(b.approverEmail ?? "").trim().toLowerCase();
    const allowSelf = await selfApprovalAllowed(pool);

    return mutate(reply, Number(id), async (db, found) => {
      const guard = checkReassign(found.request, identity.email, perms);
      if (!guard.ok) throw new Refusal(guard.status, guard.error);
      checkVersion(found, b.version);
      const approvers = await listApprovers(db);
      const target = checkNewApprover(found.request, to, approvers.map((a) => a.email), allowSelf);
      if (!target.ok) throw new Refusal(target.status, target.error);
      const name = approvers.find((a) => a.email.toLowerCase() === to)?.name || to;

      const r = await db.query(
        `UPDATE requests SET approver_email = $2, approved_by = $3, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING version`,
        [Number(id), to, name]
      );
      await addEvent(db, Number(id), "reassigned", identity, String(b.comment ?? "").trim(), {
        from: found.request.approver_email,
        fromName: found.request.approved_by,
        to,
        toName: name,
      });
      return { ok: true, version: r.rows[0].version };
    });
  });

  // The pay run: several reimbursements paid the same day with one reference
  // (a batch of cheques, one bank transfer). Each is its own transaction, so
  // one that has changed or is not payable does not hold up the rest.
  app.post("/api/reimburse-batch", { preHandler: requirePermission("pay") }, async (req, reply) => {
    const b = (req.body ?? {}) as { items?: unknown; paidOn?: unknown; reference?: unknown };
    const identity = getIdentity(req);
    const perms = await loadPermissions(req);
    const items = Array.isArray(b.items) ? b.items as { id?: unknown; version?: unknown }[] : [];
    if (!items.length) return reply.code(400).send({ ok: false, error: "Choose at least one request to pay." });
    if (items.length > MAX_PAY_RUN) {
      return reply.code(400).send({ ok: false, error: `Pay at most ${MAX_PAY_RUN} at a time.` });
    }

    // One date for the whole run, so a bad one is refused before anything is paid.
    let paidOn: string;
    try {
      paidOn = pastDate(b.paidOn, "it was paid");
    } catch (err) {
      return reply.code(400).send({ ok: false, error: (err as Error).message });
    }

    const results: { id: number; ok: boolean; error?: string }[] = [];
    for (const item of items) {
      const id = Number(item.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        results.push({ id, ok: false, error: "Not a request." });
        continue;
      }
      try {
        const done = await withRequest(pool, id, async (db, found) => {
          checkVersion(found, item.version);
          await reimburse(db, found, identity, perms, paidOn, b.reference);
          return true;
        });
        results.push(done ? { id, ok: true } : { id, ok: false, error: "Request not found." });
      } catch (err) {
        if (!(err instanceof Refusal)) throw err;
        results.push({ id, ok: false, error: err.message });
      }
    }
    return { ok: true, paid: results.filter((r) => r.ok).length, results };
  });
}
