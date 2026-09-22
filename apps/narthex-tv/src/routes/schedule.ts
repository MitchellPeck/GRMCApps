import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { requirePermission } from "../guard";
import { describeEntries, ScheduleMode, validateEntry } from "../schedule";
import {
  createEntry, deleteEntry, getScheduleRow, listScheduleRows, ScheduleInput, toEntry, updateEntry,
} from "../schedule-repo";
import { loadSettings } from "../settings";
import { resolveNow } from "../resolve";
import { listItems } from "../playlists";

const intParam = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

const isoOrNull = (value: unknown): string | null => {
  if (value === undefined || value === null || value === "") return null;
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? null : d.toISOString();
};

const dateOrNull = (value: unknown): string | null => {
  const v = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

function readInput(body: Record<string, unknown>): ScheduleInput {
  const days = Array.isArray(body.days)
    ? Array.from(new Set(body.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort()
    : [];
  return {
    playlistId: intParam(body.playlistId),
    mode: String(body.mode ?? "") as ScheduleMode,
    label: String(body.label ?? "").slice(0, 120),
    startsAt: isoOrNull(body.startsAt),
    endsAt: isoOrNull(body.endsAt),
    days,
    startTime: String(body.startTime ?? "").trim(),
    endTime: String(body.endTime ?? "").trim(),
    effectiveFrom: dateOrNull(body.effectiveFrom),
    effectiveTo: dateOrNull(body.effectiveTo),
    priority: Number.isFinite(Number(body.priority)) ? Math.round(Number(body.priority)) : 0,
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
  };
}

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/schedule", async () => {
    const rows = await listScheduleRows(pool);
    const settings = await loadSettings(pool);
    const entries = rows.map(toEntry);
    const status = new Map(
      describeEntries(entries, new Date(), settings.timezone).map((s) => [s.id, s])
    );
    return {
      ok: true,
      timezone: settings.timezone,
      entries: rows.map((row, i) => {
        const e = entries[i];
        const s = status.get(e.id)!;
        return {
          ...e,
          playlistName: row.playlist_name ?? "",
          state: s.state,
          nextStart: s.nextStart ? s.nextStart.toISOString() : null,
          currentEnd: s.currentEnd ? s.currentEnd.toISOString() : null,
        };
      }),
    };
  });

  /** What is on the screen right now — or would be at `?at=<ISO>`. */
  app.get("/api/schedule/now", async (req) => {
    const raw = String((req.query as { at?: string }).at ?? "").trim();
    const parsed = raw ? new Date(raw) : new Date();
    const at = isNaN(parsed.getTime()) ? new Date() : parsed;

    const { resolution, playlist, source, settings } = await resolveNow(pool, at);
    const items = playlist ? await listItems(pool, playlist.id) : [];
    return {
      ok: true,
      at: at.toISOString(),
      timezone: settings.timezone,
      source,
      entry: resolution.entry
        ? { id: resolution.entry.id, mode: resolution.entry.mode, label: resolution.entry.label }
        : null,
      startedAt: resolution.startedAt ? resolution.startedAt.toISOString() : null,
      endsAt: resolution.endsAt ? resolution.endsAt.toISOString() : null,
      changesAt: resolution.changesAt ? resolution.changesAt.toISOString() : null,
      playlist: playlist ? { id: Number(playlist.id), name: playlist.name } : null,
      readyCount: items.filter((i) => i.enabled && i.status === "ready").length,
      pendingCount: items.filter((i) => i.enabled && i.status !== "ready").length,
    };
  });

  app.post("/api/schedule", { preHandler: requirePermission("schedule") }, async (req, reply) => {
    const input = readInput((req.body ?? {}) as Record<string, unknown>);
    const check = validateEntry(input);
    if (!check.ok) return reply.code(400).send({ ok: false, error: check.error });
    const exists = await pool.query("SELECT 1 FROM playlists WHERE id = $1", [input.playlistId]);
    if (!exists.rowCount) return reply.code(400).send({ ok: false, error: "No such playlist." });
    const id = await createEntry(pool, input, getIdentity(req).email);
    return { ok: true, id };
  });

  app.patch("/api/schedule/:id", { preHandler: requirePermission("schedule") }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const existing = await getScheduleRow(pool, id);
    if (!existing) return reply.code(404).send({ ok: false, error: "No such schedule entry." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    // A PATCH that only flips `enabled` must not have to resend the whole
    // entry, so the merge happens against what is stored.
    const merged = { ...toEntry(existing), ...readInputPartial(body) };
    const check = validateEntry(merged);
    if (!check.ok) return reply.code(400).send({ ok: false, error: check.error });

    await updateEntry(pool, id, {
      playlistId: merged.playlistId,
      mode: merged.mode,
      label: merged.label,
      startsAt: merged.startsAt,
      endsAt: merged.endsAt,
      days: merged.days,
      startTime: merged.startTime,
      endTime: merged.endTime,
      effectiveFrom: merged.effectiveFrom,
      effectiveTo: merged.effectiveTo,
      priority: merged.priority,
      enabled: merged.enabled,
    });
    return { ok: true };
  });

  app.delete("/api/schedule/:id", { preHandler: requirePermission("schedule") }, async (req, reply) => {
    const gone = await deleteEntry(pool, intParam((req.params as { id: string }).id));
    if (!gone) return reply.code(404).send({ ok: false, error: "No such schedule entry." });
    return { ok: true };
  });
}

// Only the fields actually present in the body, so a partial update leaves the
// rest of the stored entry alone.
function readInputPartial(body: Record<string, unknown>): Partial<ScheduleInput> {
  const out: Partial<ScheduleInput> = {};
  const full = readInput(body);
  if (body.playlistId !== undefined) out.playlistId = full.playlistId;
  if (body.mode !== undefined) out.mode = full.mode;
  if (body.label !== undefined) out.label = full.label;
  if (body.startsAt !== undefined) out.startsAt = full.startsAt;
  if (body.endsAt !== undefined) out.endsAt = full.endsAt;
  if (body.days !== undefined) out.days = full.days;
  if (body.startTime !== undefined) out.startTime = full.startTime;
  if (body.endTime !== undefined) out.endTime = full.endTime;
  if (body.effectiveFrom !== undefined) out.effectiveFrom = full.effectiveFrom;
  if (body.effectiveTo !== undefined) out.effectiveTo = full.effectiveTo;
  if (body.priority !== undefined) out.priority = full.priority;
  if (body.enabled !== undefined) out.enabled = full.enabled;
  return out;
}
