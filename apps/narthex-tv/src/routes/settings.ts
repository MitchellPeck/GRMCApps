import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { requirePermission } from "../guard";
import {
  AppSettings, DEFAULT_SETTINGS, isValidTimeZone, loadSettings,
  saveSettings, validateSettings,
} from "../settings";
import {
  checkPermissionChange, effectivePermissions, PermissionRow,
} from "../permissions";
import {
  listPermissionRows, removePermissionRow, upsertPermissionRow,
} from "../app-users";

const num = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return isFinite(n) ? Math.round(n) : undefined;
};

const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  (allowed as readonly string[]).includes(String(value)) ? (String(value) as T) : undefined;

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Readable by anyone who can open the app: the values are display choices,
  // not secrets, and the UI needs them to render durations sensibly.
  app.get("/api/settings", async () => ({
    ok: true,
    settings: await loadSettings(pool),
    defaults: DEFAULT_SETTINGS,
  }));

  app.put("/api/settings", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;

    // One table of validators, checked exhaustively by the compiler, rather
    // than a hand-written if per field that can quietly miss one.
    const checked = validateSettings(b);
    if (!checked.ok) return reply.code(400).send({ ok: false, error: checked.error });
    await saveSettings(pool, checked.value);

    return {
      ok: true,
      settings: await loadSettings(pool),
    };
  });

  // ── permissions ──────────────────────────────────────────────────────────

  const view = (row: PermissionRow) => ({
    email: row.email,
    name: row.name,
    canUpload: row.can_upload,
    canSchedule: row.can_schedule,
    canManage: row.can_manage,
    isAdmin: row.is_admin,
    effective: effectivePermissions(row),
  });

  app.get("/api/permissions", { preHandler: requirePermission("admin") }, async () => ({
    ok: true,
    users: (await listPermissionRows(pool)).map(view),
  }));

  app.put("/api/permissions", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!email.includes("@")) {
      return reply.code(400).send({ ok: false, error: "That isn't an email address." });
    }
    // Demoting the last administrator would lock everyone out of this screen.
    if (b.isAdmin === false) {
      const check = checkPermissionChange(await listPermissionRows(pool), { type: "demote", email });
      if (!check.ok) return reply.code(409).send({ ok: false, error: check.error });
    }
    await upsertPermissionRow(pool, email, {
      name: typeof b.name === "string" ? b.name : undefined,
      can_upload: typeof b.canUpload === "boolean" ? b.canUpload : undefined,
      can_schedule: typeof b.canSchedule === "boolean" ? b.canSchedule : undefined,
      can_manage: typeof b.canManage === "boolean" ? b.canManage : undefined,
      is_admin: typeof b.isAdmin === "boolean" ? b.isAdmin : undefined,
    });
    return { ok: true, users: (await listPermissionRows(pool)).map(view) };
  });

  app.delete("/api/permissions/:email", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const email = decodeURIComponent((req.params as { email: string }).email).toLowerCase();
    const check = checkPermissionChange(await listPermissionRows(pool), { type: "remove", email });
    if (!check.ok) return reply.code(409).send({ ok: false, error: check.error });
    await removePermissionRow(pool, email);
    return { ok: true, users: (await listPermissionRows(pool)).map(view) };
  });
}
