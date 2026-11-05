import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { requirePermission } from "../guard";
import {
  listApprovers,
  listPermissionRows,
  removePermissionRow,
  upsertPermissionRow,
} from "../app-users";
import { ROLE_PRESETS, RoleName, checkPermissionChange } from "../permissions";

// Only real booleans change a flag. The string "false" is truthy, and treating
// it as a value is how the last-admin guard could be walked around.
function flag(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export async function permissionRoutes(app: FastifyInstance): Promise<void> {
  // The approver picker is needed by anyone who can submit, so it is not gated
  // behind admin like the rest of this file.
  app.get("/api/approvers", async () => {
    const rows = await listApprovers(pool);
    return { ok: true, approvers: rows.map((r) => ({ email: r.email, name: r.name })) };
  });

  app.get("/api/permissions", { preHandler: requirePermission("admin") }, async () => ({
    ok: true,
    permissions: await listPermissionRows(pool),
  }));

  app.put(
    "/api/permissions/:email",
    { preHandler: requirePermission("admin") },
    async (req, reply) => {
      const { email } = req.params as { email: string };
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Only an explicit false can strip the last admin; undefined means "not
      // being changed" and the COALESCE upsert leaves it alone.
      if (body.is_admin === false) {
        const guard = checkPermissionChange(await listPermissionRows(pool), {
          type: "demote",
          email,
        });
        if (!guard.ok) return reply.code(409).send({ ok: false, error: guard.error });
      }

      // A role sets all six expense flags at once; admin is left alone.
      let preset: Partial<Record<string, boolean>> = {};
      if (body.role !== undefined) {
        const role = String(body.role) as RoleName;
        if (!(role in ROLE_PRESETS)) return reply.code(400).send({ ok: false, error: "Unknown role." });
        preset = ROLE_PRESETS[role];
      }

      await upsertPermissionRow(pool, email, {
        name: body.name === undefined ? undefined : String(body.name),
        can_submit: preset.can_submit ?? flag(body.can_submit),
        can_submit_for_others: preset.can_submit_for_others ?? flag(body.can_submit_for_others),
        can_approve: preset.can_approve ?? flag(body.can_approve),
        can_manage: preset.can_manage ?? flag(body.can_manage),
        can_pay: preset.can_pay ?? flag(body.can_pay),
        can_audit: preset.can_audit ?? flag(body.can_audit),
        is_admin: flag(body.is_admin),
        default_approver_email:
          body.default_approver_email === undefined
            ? undefined
            : String(body.default_approver_email || "").trim().toLowerCase() || null,
      });
      return { ok: true };
    }
  );

  app.delete(
    "/api/permissions/:email",
    { preHandler: requirePermission("admin") },
    async (req, reply) => {
      const { email } = req.params as { email: string };
      const guard = checkPermissionChange(await listPermissionRows(pool), {
        type: "remove",
        email,
      });
      if (!guard.ok) return reply.code(409).send({ ok: false, error: guard.error });

      const removed = await removePermissionRow(pool, email);
      if (!removed) return reply.code(404).send({ ok: false, error: "No permissions found." });
      return { ok: true };
    }
  );
}
