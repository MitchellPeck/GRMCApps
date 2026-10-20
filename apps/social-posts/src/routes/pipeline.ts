import { FastifyInstance } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { addDays } from "../dates";
import { getSetting, setSetting } from "../settings";
import { buildCaptureIcs } from "../pipeline/ical";
import { draftAll, draftCaptions, parseDraftRequest, resolveForDraft } from "../pipeline/caption";
import { listDraftHistory } from "../pipeline/history";
import { planFromEpisode, proposeSeriesPlan, saveSeriesPlan } from "../pipeline/planning";
import { listCampaigns } from "../mailchimp";
import { listEpisodes } from "../buzzsprout";
import { getApprovedImageBytes } from "../approvals-client";
import { describeRule, occurrences, parseRecurrenceInput, parseRule } from "../pipeline/recurrence";
import {
  HORIZON_DAYS, createRecurrence, deleteRecurrence, getRecurrence, listRecurrences, materialize, updateRecurrence,
} from "../pipeline/recurring";
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
  deleteMedia, duplicateEvent, getContent, getEvent, listContent, listEvents, listMedia, updateContent, updateEvent,
  updateMedia,
} from "../pipeline/repo";

const ICAL_SETTING = "pipeline_ical_token";

async function icalToken(): Promise<string> {
  let token = await getSetting(pool, ICAL_SETTING);
  if (!token) {
    token = randomBytes(24).toString("base64url");
    await setSetting(pool, ICAL_SETTING, token);
  }
  return token;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

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
    recurrenceHorizonDays: HORIZON_DAYS,
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
    // Recurring posts exist HORIZON_DAYS ahead; looking further out (paging
    // the calendar forward) generates the occurrences that range needs.
    const to = dateParam(q, "to");
    const today = await referenceDate(pool);
    if (to && to > addDays(today, HORIZON_DAYS)) await materialize(pool, today, to);
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
    const scope = (req.body as { scope?: string } | null)?.scope === "future" ? "future" : "this";
    const r = await updateContent(pool, (req.params as { id: string }).id, input.value, scope);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  app.delete("/api/pipeline/content/:id", async (req) => guard(async () => {
    const r = await deleteContent(pool, (req.params as { id: string }).id);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  // Drafts from the editor's current (possibly unsaved) state; logs it when the post exists.
  app.post("/api/pipeline/draft-caption", async (req) => guard(async () => {
    const input = parseDraftRequest(req.body);
    if (!input.ok) return input;
    const r = await draftCaptions(pool, input.value, getIdentity(req).email);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  // What Draft with Claude would use, for the editor's source panel. A source
  // service failing is reported here, not raised: pasting by hand still works.
  app.post("/api/pipeline/source/preview", async (req) => guard(async () => {
    const input = parseDraftRequest(req.body, { preview: true });
    if (!input.ok) return input;
    try {
      const { effective, source } = await resolveForDraft(pool, input.value);
      const { content, ...rest } = source || ({} as Record<string, string>);
      return { ok: true, effective: { source: effective.source, instructions: effective.instructions, from: effective.from },
               source: source ? { ...rest, excerpt: (content || "").slice(0, 400) } : null };
    } catch (e) {
      return { ok: true, effective: null, source: null, error: (e as Error).message };
    }
  }));

  app.get("/api/pipeline/sources/campaigns", async (req) => guard(async () => {
    const subject = String((req.query as Query).subject || "").trim();
    if (!subject) return { ok: false, error: "Say which campaigns: text their subject contains." };
    return { ok: true, campaigns: await listCampaigns(pool, subject) };
  }));

  app.get("/api/pipeline/sources/episodes", async () => guard(async () => ({ ok: true, episodes: await listEpisodes(pool) })));

  app.get("/api/pipeline/content/:id/drafts", async (req) => guard(async () =>
    ({ ok: true, drafts: await listDraftHistory(pool, (req.params as { id: string }).id) })));

  app.post("/api/pipeline/draft-all", async (req) => guard(async () => {
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) return { ok: false, error: "Say which posts to draft." };
    return { ok: true, results: await draftAll(pool, ids as string[], getIdentity(req).email) };
  }));

  // Thumbnails of approved files for media items (the list itself is
  // /api/metricool/approved-images). Fetched as the signed-in person, so
  // Approvals applies its own access rules.
  app.get("/api/pipeline/approved/:id/image", async (req, reply) => {
    try {
      const { bytes, contentType } = await getApprovedImageBytes(getIdentity(req), Number((req.params as { id: string }).id));
      reply.header("content-type", contentType).header("cache-control", "private, max-age=300");
      return reply.send(bytes);
    } catch (e) {
      return reply.code(404).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/pipeline/events/:id/duplicate", async (req) => guard(async () => {
    const b = (req.body ?? {}) as { name?: string; startDate?: string; shiftDays?: number };
    if (b.startDate && !isIsoDate(b.startDate)) return { ok: false, error: "The new start date must be a date like 2027-07-10." };
    const r = await duplicateEvent(pool, (req.params as { id: string }).id, {
      name: String(b.name || "").trim(), startDate: b.startDate || null,
      shiftDays: b.shiftDays == null ? null : Number(b.shiftDays),
    }, getIdentity(req).email);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  app.post("/api/pipeline/events/:id/plan-episode", async (req) => guard(async () => {
    const b = (req.body ?? {}) as { episodeId?: string | number; angles?: unknown };
    if (!b.episodeId) return { ok: false, error: "Pick an episode." };
    const angles = Array.isArray(b.angles) ? b.angles.map(String) : [];
    const r = await planFromEpisode(pool, (req.params as { id: string }).id, String(b.episodeId), angles,
      getIdentity(req).email, await referenceDate(pool));
    return r.ok ? { ok: true, items: r.value } : r;
  }));

  app.post("/api/pipeline/events/:id/plan-series/propose", async (req) => guard(async () => {
    const b = (req.body ?? {}) as { count?: number; cadence?: string; startDate?: string };
    const r = await proposeSeriesPlan(pool, (req.params as { id: string }).id,
      { count: Number(b.count), cadence: String(b.cadence || "weekly"), startDate: String(b.startDate || "") });
    return r.ok ? { ok: true, posts: r.value } : r;
  }));

  app.post("/api/pipeline/events/:id/plan-series", async (req) => guard(async () => {
    const posts = (req.body as { posts?: unknown } | null)?.posts;
    if (!Array.isArray(posts)) return { ok: false, error: "There's no plan to save." };
    const r = await saveSeriesPlan(pool, (req.params as { id: string }).id, posts as any[], getIdentity(req).email);
    return r.ok ? { ok: true, items: r.value } : r;
  }));

  // ── Recurring posts ──
  app.get("/api/pipeline/recurrences", async () => guard(async () =>
    ({ ok: true, recurrences: await listRecurrences(pool, await referenceDate(pool)) })));

  app.get("/api/pipeline/recurrences/:id", async (req) => guard(async () => {
    const r = await getRecurrence(pool, (req.params as { id: string }).id, await referenceDate(pool));
    return r ? { ok: true, recurrence: r } : { ok: false, error: "Recurring post not found." };
  }));

  // What a rule would produce, so the form can show the next few dates as you type.
  app.post("/api/pipeline/recurrences/preview", async (req) => guard(async () => {
    const rule = parseRule((req.body as { rule?: unknown } | null)?.rule);
    if (!rule.ok) return rule;
    const today = await referenceDate(pool);
    return { ok: true, summary: describeRule(rule.value),
             dates: occurrences(rule.value, addDays(today, 400)).filter((d) => d >= today).slice(0, 5) };
  }));

  app.post("/api/pipeline/recurrences", async (req) => guard(async () => {
    const input = parseRecurrenceInput(req.body, "create");
    if (!input.ok) return input;
    const from = (req.body as { fromContentId?: string } | null)?.fromContentId || undefined;
    const r = await createRecurrence(pool, input.value, getIdentity(req).email, await referenceDate(pool), "", from);
    return r.ok ? { ok: true, recurrence: r.value } : r;
  }));

  app.patch("/api/pipeline/recurrences/:id", async (req) => guard(async () => {
    const input = parseRecurrenceInput(req.body, "patch");
    if (!input.ok) return input;
    const r = await updateRecurrence(pool, (req.params as { id: string }).id, input.value, await referenceDate(pool));
    return r.ok ? { ok: true, recurrence: r.value } : r;
  }));

  app.delete("/api/pipeline/recurrences/:id", async (req) => guard(async () => {
    const r = await deleteRecurrence(pool, (req.params as { id: string }).id, await referenceDate(pool));
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  // ── Capture calendar feed ──
  // The feed URL is the secret (calendar apps can't sign in), so it can be
  // reset, which breaks every existing subscription at once.
  app.get("/api/pipeline/ical", async (req) => guard(async () => {
    const base = `https://${req.hostname}/ical/${await icalToken()}/capture.ics`;
    return { ok: true, url: base, mineUrl: base + "?who=" + encodeURIComponent(getIdentity(req).email) };
  }));

  app.post("/api/pipeline/ical/reset", async (req) => guard(async () => {
    await setSetting(pool, ICAL_SETTING, randomBytes(24).toString("base64url"));
    const base = `https://${req.hostname}/ical/${await icalToken()}/capture.ics`;
    return { ok: true, url: base, mineUrl: base + "?who=" + encodeURIComponent(getIdentity(req).email) };
  }));

  // Reached WITHOUT the hub login (its own Traefik router), so it checks the token itself.
  app.get("/ical/:token/capture.ics", async (req, reply) => {
    const { token } = req.params as { token: string };
    const stored = await getSetting(pool, ICAL_SETTING);
    if (!stored || !sameSecret(token, stored)) return reply.code(404).send("Not found");
    const who = String((req.query as Query).who || "").trim();
    const today = await referenceDate(pool);
    const media = await listMedia(pool, { from: addDays(today, -30), to: addDays(today, 365), assigneeEmail: who || undefined });
    reply.header("content-type", "text/calendar; charset=utf-8");
    reply.header("cache-control", "private, max-age=900");
    return buildCaptureIcs(media, {
      name: who ? "GRMC captures: " + who : "GRMC capture calendar",
      pageUrl: `https://${req.hostname}/pipeline#calendar`, stamp: new Date(),
    });
  });

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
