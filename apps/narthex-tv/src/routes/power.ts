import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { requirePermission } from "../guard";
import { resolvePower, validateWindow } from "../power";
import {
  addWindow, listPowerEvents, listWindows, recordPowerEvent, removeWindow,
  seedDefaultWindows, updateWindow,
} from "../hours";
import { getPowerActionRaw, loadSettings, setPowerActionRaw } from "../settings";
import { parseAction, realDeps, runAction, serializeAction } from "../power-actions";

const intParam = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

export async function powerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/hours", async () => {
    const settings = await loadSettings(pool);
    const windows = await listWindows(pool);
    const state = resolvePower(settings.hoursMode, windows, new Date(), settings.timezone);
    return {
      ok: true,
      mode: settings.hoursMode,
      timezone: settings.timezone,
      windows,
      // Surfaced so the admin screen can warn about a grid that would leave
      // the narthex dark indefinitely, instead of it being found on a Sunday.
      neverOn: settings.hoursMode === "scheduled" && windows.length > 0 && !state.on && !state.changesAt,
      state: {
        on: state.on,
        changesAt: state.changesAt ? state.changesAt.toISOString() : null,
      },
      events: await listPowerEvents(pool, 10),
      onAction: await getPowerActionRaw(pool, "on"),
      offAction: await getPowerActionRaw(pool, "off"),
    };
  });

  // Switching to scheduled for the first time seeds a sensible week rather
  // than handing someone an empty table that means "always on" anyway.
  app.post("/api/hours/seed", { preHandler: requirePermission("admin") }, async () => ({
    ok: true,
    windows: await seedDefaultWindows(pool),
  }));

  app.post("/api/hours", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const candidate = {
      day: Number(b.day),
      startTime: String(b.startTime ?? "").trim(),
      endTime: String(b.endTime ?? "").trim(),
    };
    const check = validateWindow(candidate);
    if (!check.ok) return reply.code(400).send({ ok: false, error: check.error });
    return { ok: true, window: await addWindow(pool, candidate) };
  });

  app.patch("/api/hours/:id", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const existing = (await listWindows(pool)).find((w) => w.id === id);
    if (!existing) return reply.code(404).send({ ok: false, error: "No such window." });

    const merged = {
      day: b.day === undefined ? existing.day : Number(b.day),
      startTime: b.startTime === undefined ? existing.startTime : String(b.startTime).trim(),
      endTime: b.endTime === undefined ? existing.endTime : String(b.endTime).trim(),
    };
    const check = validateWindow(merged);
    if (!check.ok) return reply.code(400).send({ ok: false, error: check.error });

    await updateWindow(pool, id, {
      ...merged,
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
    });
    return { ok: true, windows: await listWindows(pool) };
  });

  app.delete("/api/hours/:id", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const gone = await removeWindow(pool, intParam((req.params as { id: string }).id));
    if (!gone) return reply.code(404).send({ ok: false, error: "No such window." });
    return { ok: true, windows: await listWindows(pool) };
  });

  // ── the power hook ───────────────────────────────────────────────────────

  app.put("/api/power", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const when of ["on", "off"] as const) {
      const key = when === "on" ? "onAction" : "offAction";
      if (b[key] === undefined) continue;
      const parsed = parseAction(b[key]);
      if (!parsed.ok) {
        return reply.code(400).send({ ok: false, error: `Turn-${when} action: ${parsed.error}` });
      }
      await setPowerActionRaw(pool, when, serializeAction(parsed.action));
    }
    return {
      ok: true,
      onAction: await getPowerActionRaw(pool, "on"),
      offAction: await getPowerActionRaw(pool, "off"),
    };
  });

  // Fire one by hand. The only way to find out whether a television actually
  // answers is to ask it, and doing that from the settings screen beats
  // waiting until 07:30 on a Sunday to find out it does not.
  app.post("/api/power/test/:when", { preHandler: requirePermission("admin") }, async (req, reply) => {
    const when = (req.params as { when: string }).when === "on" ? "on" : "off";
    const parsed = parseAction(await getPowerActionRaw(pool, when));
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: parsed.error });
    if (parsed.action.kind === "none") {
      return reply.code(400).send({ ok: false, error: `No turn-${when} action is configured.` });
    }
    const result = await runAction(parsed.action, realDeps);
    await recordPowerEvent(pool, `test-${when}`, result.ok, result.detail);
    return { ok: result.ok, detail: result.detail, events: await listPowerEvents(pool, 10) };
  });
}
