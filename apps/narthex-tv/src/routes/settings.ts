import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { requirePermission } from "../guard";
import {
  AppSettings, DEFAULT_SETTINGS, getDefaultPlaylistId, isValidTimeZone, loadSettings,
  saveSettings, setDefaultPlaylistId,
} from "../settings";
import {
  checkPermissionChange, effectivePermissions, PermissionRow,
} from "../permissions";
import {
  listPermissionRows, removePermissionRow, upsertPermissionRow,
} from "../app-users";
import { DEFAULT_IDLE, loadIdle, saveIdle } from "../idle";
import { THEMES } from "../notices";

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
    defaultPlaylistId: await getDefaultPlaylistId(pool),
  }));

  // ── the idle screen ──────────────────────────────────────────────────────
  app.get("/api/idle", async () => ({
    ok: true,
    idle: await loadIdle(pool),
    defaults: DEFAULT_IDLE,
    themes: Object.keys(THEMES).filter((t) => t !== "urgent"),
  }));

  app.put("/api/idle", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof saveIdle>[1] = {};
    if (typeof b.headline === "string") patch.headline = b.headline;
    if (typeof b.message === "string") patch.message = b.message;
    if (typeof b.showMark === "boolean") patch.showMark = b.showMark;
    if (b.theme !== undefined) {
      const theme = String(b.theme);
      if (!Object.keys(THEMES).includes(theme)) {
        return reply.code(400).send({ ok: false, error: "That isn't a colourway I know." });
      }
      patch.theme = theme;
    }
    if (b.logoMediaId !== undefined) {
      const id = Number(b.logoMediaId);
      if (id) {
        const exists = await pool.query(
          "SELECT 1 FROM media WHERE id = $1 AND kind = 'image' AND status = 'ready'", [id]
        );
        if (!exists.rowCount) {
          return reply.code(400).send({
            ok: false,
            error: "Pick a picture from the media library that has finished converting.",
          });
        }
      }
      patch.logoMediaId = id > 0 ? id : 0;
    }
    await saveIdle(pool, patch);
    return { ok: true, idle: await loadIdle(pool) };
  });

  app.put("/api/settings", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<AppSettings> = {};

    if (b.timezone !== undefined) {
      const tz = String(b.timezone).trim();
      if (!isValidTimeZone(tz)) {
        return reply.code(400).send({ ok: false, error: `"${tz}" isn't a timezone I know.` });
      }
      patch.timezone = tz;
    }
    const imageSeconds = num(b.imageSeconds);
    if (imageSeconds !== undefined) patch.imageSeconds = Math.min(3600, Math.max(1, imageSeconds));
    const slideSeconds = num(b.slideSeconds);
    if (slideSeconds !== undefined) patch.slideSeconds = Math.min(3600, Math.max(1, slideSeconds));
    const transitionMs = num(b.transitionMs);
    if (transitionMs !== undefined) patch.transitionMs = Math.min(5000, Math.max(0, transitionMs));
    const pollSeconds = num(b.pollSeconds);
    if (pollSeconds !== undefined) patch.pollSeconds = Math.min(600, Math.max(3, pollSeconds));

    const transition = pick(b.transition, ["none", "fade"] as const);
    if (transition) patch.transition = transition;
    const fit = pick(b.fit, ["contain", "cover"] as const);
    if (fit) patch.fit = fit;
    const clock = pick(b.clock, ["off", "time", "time_date"] as const);
    if (clock) patch.clock = clock;
    const clockPosition = pick(
      b.clockPosition,
      ["top-left", "top-right", "bottom-left", "bottom-right"] as const
    );
    if (clockPosition) patch.clockPosition = clockPosition;

    if (b.background !== undefined) {
      const value = String(b.background).trim();
      if (!/^#[0-9a-fA-F]{3,8}$/.test(value)) {
        return reply.code(400).send({ ok: false, error: "The background needs to be a hex colour." });
      }
      patch.background = value;
    }
    if (typeof b.footerText === "string") patch.footerText = b.footerText.slice(0, 300);
    if (typeof b.idleMessage === "string") patch.idleMessage = b.idleMessage.slice(0, 300);
    if (typeof b.videoLoopSingle === "boolean") patch.videoLoopSingle = b.videoLoopSingle;

    await saveSettings(pool, patch);

    if (b.defaultPlaylistId !== undefined) {
      const id = num(b.defaultPlaylistId);
      if (!id) {
        await setDefaultPlaylistId(pool, null);
      } else {
        const exists = await pool.query("SELECT 1 FROM playlists WHERE id = $1", [id]);
        if (!exists.rowCount) {
          return reply.code(400).send({ ok: false, error: "No such playlist." });
        }
        await setDefaultPlaylistId(pool, id);
      }
    }

    return {
      ok: true,
      settings: await loadSettings(pool),
      defaultPlaylistId: await getDefaultPlaylistId(pool),
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
