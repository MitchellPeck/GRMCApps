import { FastifyInstance } from "fastify";
import { pool } from "../db";
import { getIdentity } from "../identity";
import { referenceDate } from "../schedule";
import { GAP_THRESHOLDS, PLATFORMS, UPCOMING_DAYS } from "../pipeline/config";
import {
  CONTENT_STATUSES, EVENT_KINDS, GATED_STATUSES, MEDIA_STATUSES, MEDIA_TYPES, READY_STATUSES,
  isIsoDate, parseContentInput, parseEventInput, parseMediaInput,
} from "../pipeline/rules";
import {
  createContent, createEvent, createMedia, dashboardGaps, dashboardSummary, deleteContent, deleteEvent,
  deleteMedia, getContent, getEvent, listContent, listEvents, listMedia, updateContent, updateEvent, updateMedia,
} from "../pipeline/repo";

type Query = Record<string, string | undefined>;

// Query-string filters, validated the same way bodies are: a malformed date or
// an unknown status is an error, never silently ignored.
function dateParam(q: Query, key: string): string | undefined {
  const v = q[key];
  if (!v) return undefined;
  if (!isIsoDate(v)) throw new Error(`"${key}" must be a date like 2026-11-01.`);
  return v;
}

function listParam(q: Query, key: string, allowed?: readonly string[]): string[] | undefined {
  const v = q[key];
  if (!v) return undefined;
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = allowed ? list.filter((s) => !allowed.includes(s)) : [];
  if (bad.length) throw new Error(`Unknown ${key}: ${bad.join(", ")}.`);
  return list;
}

const flag = (q: Query, key: string) => q[key] === "1" || q[key] === "true";

// Every route answers { ok: true, ... } or { ok: false, error }, like the rest
// of the app, so the client has one error path.
async function guard<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try { return await fn(); }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // The page's dropdowns and thresholds come from here, so they can never
  // drift from what the server accepts.
  app.get("/api/pipeline/meta", async () => guard(async () => ({
    ok: true,
    today: await referenceDate(pool),
    contentStatuses: CONTENT_STATUSES, mediaStatuses: MEDIA_STATUSES, mediaTypes: MEDIA_TYPES,
    eventKinds: EVENT_KINDS, platforms: PLATFORMS, gatedStatuses: GATED_STATUSES,
    readyStatuses: READY_STATUSES, thresholds: GAP_THRESHOLDS, upcomingDays: UPCOMING_DAYS,
  })));

  // ── Events ──
  app.get("/api/pipeline/events", async (req) => guard(async () => {
    const q = req.query as Query;
    const archived = q.archived === undefined || q.archived === "all" ? undefined : flag(q, "archived");
    return { ok: true, events: await listEvents(pool, { archived }) };
  }));

  app.post("/api/pipeline/events", async (req) => guard(async () => {
    const input = parseEventInput(req.body, "create");
    if (!input.ok) return input;
    return { ok: true, event: await createEvent(pool, input.value) };
  }));

  app.get("/api/pipeline/events/:id", async (req) => guard(async () => {
    const r = await getEvent(pool, (req.params as { id: string }).id);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  app.patch("/api/pipeline/events/:id", async (req) => guard(async () => {
    const input = parseEventInput(req.body, "patch");
    if (!input.ok) return input;
    const r = await updateEvent(pool, (req.params as { id: string }).id, input.value);
    return r.ok ? { ok: true, event: r.value } : r;
  }));

  app.delete("/api/pipeline/events/:id", async (req) => guard(async () => {
    const r = await deleteEvent(pool, (req.params as { id: string }).id);
    return r.ok ? { ok: true } : r;
  }));

  // ── Content items ──
  app.get("/api/pipeline/content", async (req) => guard(async () => {
    const q = req.query as Query;
    const items = await listContent(pool, {
      from: dateParam(q, "from"), to: dateParam(q, "to"), eventId: q.eventId || undefined,
      platform: q.platform || undefined, statuses: listParam(q, "status", CONTENT_STATUSES),
      ownerEmail: q.ownerEmail || undefined, ids: listParam(q, "ids"),
      undated: flag(q, "undated"), includeCancelled: flag(q, "includeCancelled"),
    });
    return { ok: true, items };
  }));

  app.post("/api/pipeline/content", async (req) => guard(async () => {
    const input = parseContentInput(req.body, "create");
    if (!input.ok) return input;
    const r = await createContent(pool, input.value, getIdentity(req).email);
    return r.ok ? { ok: true, item: r.value } : r;
  }));

  app.get("/api/pipeline/content/:id", async (req) => guard(async () => {
    const r = await getContent(pool, (req.params as { id: string }).id);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  app.patch("/api/pipeline/content/:id", async (req) => guard(async () => {
    const input = parseContentInput(req.body, "patch");
    if (!input.ok) return input;
    const r = await updateContent(pool, (req.params as { id: string }).id, input.value);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  app.delete("/api/pipeline/content/:id", async (req) => guard(async () => {
    const r = await deleteContent(pool, (req.params as { id: string }).id);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  // ── Media assets ──
  app.get("/api/pipeline/media", async (req) => guard(async () => {
    const q = req.query as Query;
    const media = await listMedia(pool, {
      from: dateParam(q, "from"), to: dateParam(q, "to"), eventId: q.eventId || undefined,
      assigneeEmail: q.assigneeEmail || undefined, statuses: listParam(q, "status", MEDIA_STATUSES),
      unscheduled: flag(q, "unscheduled"), ids: listParam(q, "ids"),
    });
    return { ok: true, media };
  }));

  app.post("/api/pipeline/content/:id/media", async (req) => guard(async () => {
    const input = parseMediaInput(req.body, "create");
    if (!input.ok) return input;
    const r = await createMedia(pool, (req.params as { id: string }).id, input.value);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  app.patch("/api/pipeline/media/:id", async (req) => guard(async () => {
    const input = parseMediaInput(req.body, "patch");
    if (!input.ok) return input;
    const r = await updateMedia(pool, (req.params as { id: string }).id, input.value);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  app.delete("/api/pipeline/media/:id", async (req) => guard(async () => {
    const r = await deleteMedia(pool, (req.params as { id: string }).id);
    return r.ok ? { ok: true } : r;
  }));

  // ── Dashboard ── computed fresh from the same tables on every request.
  app.get("/api/pipeline/dashboard/summary", async () => guard(async () =>
    ({ ok: true, ...(await dashboardSummary(pool, await referenceDate(pool))) })));

  app.get("/api/pipeline/dashboard/gaps", async () => guard(async () =>
    ({ ok: true, ...(await dashboardGaps(pool, await referenceDate(pool))) })));

  // The pipeline page itself.
  app.get("/pipeline", async (_req, reply) => reply.sendFile("pipeline.html"));
}
