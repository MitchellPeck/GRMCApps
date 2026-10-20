// Draft with Claude. Works out the profile in force for the post (its own
// override, its recurrence's, its event's), fetches the source item that
// profile points at for the post's date, builds one prompt, and asks Claude.
// Works from the editor's state, saved or not; draftAndSave works from a
// saved post and stores the result.
import { Pool } from "pg";
import { callClaude, stripJsonFences } from "../claude";
import { getSetting } from "../settings";
import { formatMonthDayYear } from "../dates";
import { DEFAULT_PLATFORMS, PLATFORMS } from "./config";
import { countChars } from "./platforms";
import { Result } from "./rules";
import { Effective, Override, SourceRef, effectiveProfile, parseOverride, parseSourceRef } from "./drafting";
import { DEFAULT_VOICE } from "./drafting-seed";
import { SourceContent, buildDraftPrompt } from "./prompt";
import { resolveSource } from "./sources";
import { logDraft } from "./history";
import { ContentRow, getContentRow } from "./repo";

export interface DraftRequest {
  contentItemId: string | null; title: string; brief: string; phase: string; eventId: string | null;
  platforms: string[]; publishDate: string | null; captionMode: "same" | "separate";
  caption: string; captions: Record<string, string>; drafting: Override; sourceRef: SourceRef | null;
}
export interface DraftResult { caption?: string; captions?: Record<string, string>; warnings: string[]; source: SourceContent | null }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function parseDraftRequest(raw: unknown, opts: { preview?: boolean } = {}): Result<DraftRequest> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const known = PLATFORMS.map((p) => p.key);
  const platforms = Array.isArray(b.platforms) ? b.platforms.filter((p: unknown) => known.includes(p as string)) : [];
  const title = String(b.title ?? "").trim(), brief = String(b.brief ?? "").trim();
  if (!opts.preview && !title && !brief) return fail("Write a title or a brief first so there's something to draft from.");
  const drafting = parseOverride(b.drafting ?? {});
  if (!drafting.ok) return drafting;
  const sourceRef = parseSourceRef(b.sourceRef ?? null);
  if (!sourceRef.ok) return sourceRef;
  return { ok: true, value: {
    contentItemId: typeof b.contentItemId === "string" && b.contentItemId ? b.contentItemId : null,
    title, brief, phase: String(b.phase ?? ""), eventId: b.eventId || null,
    platforms: platforms.length ? platforms : DEFAULT_PLATFORMS,
    publishDate: typeof b.publishDate === "string" && b.publishDate ? b.publishDate : null,
    captionMode: b.captionMode === "separate" ? "separate" : "same",
    caption: String(b.caption ?? ""), captions: b.captions && typeof b.captions === "object" ? b.captions : {},
    drafting: drafting.value, sourceRef: sourceRef.value,
  } };
}

/** The profile in force and its source item. Throws if a source service fails. */
export async function resolveForDraft(pool: Pool, req: DraftRequest) {
  const ev = req.eventId
    ? (await pool.query("SELECT name, kind, notes, drafting, start_date::text, end_date::text FROM events WHERE id = $1", [req.eventId])).rows[0]
    : null;
  const rec = req.contentItemId
    ? (await pool.query(
        "SELECT r.drafting FROM content_items ci JOIN recurrences r ON r.id = ci.recurrence_id WHERE ci.id = $1", [req.contentItemId])).rows[0]
    : null;
  const effective: Effective = effectiveProfile(
    ev ? { notes: ev.notes || "", drafting: ev.drafting || {} } : null,
    rec ? { drafting: rec.drafting || {} } : null,
    { drafting: req.drafting },
  );
  const source = await resolveSource(pool, effective.source, req.sourceRef, req.publishDate);
  const event = ev ? { name: ev.name, kind: ev.kind, notes: ev.notes || "", startDate: ev.start_date, endDate: ev.end_date } : null;
  return { effective, source, event };
}

function overLimit(key: string, text: string): string {
  const p = PLATFORMS.find((x) => x.key === key)!;
  const n = countChars(key, text);
  return n > p.limit ? `${p.label} draft is ${n} characters; the limit is ${p.limit}. Trim it before sending.` : "";
}

async function shortenForX(pool: Pool, text: string): Promise<string> {
  const raw = await callClaude(pool, 'Return ONLY a JSON object with key "x", no markdown fences.',
    `Shorten this X post to at most 250 characters (links count as 23), keeping its point and any link:\n\n${text}`);
  try {
    const x = JSON.parse(stripJsonFences(raw)).x;
    return typeof x === "string" && x.trim() ? x.trim() : text;
  } catch { return text; }
}

export async function draftCaptions(pool: Pool, req: DraftRequest, createdBy: string): Promise<Result<DraftResult>> {
  let resolved;
  try { resolved = await resolveForDraft(pool, req); }
  catch (e) { return fail((e as Error).message); }
  const { effective, source, event } = resolved;
  if (effective.source.kind === "buzzsprout" && !source) return fail("Pick the episode this post is about.");

  let seriesPosition: { n: number; of: number } | null = null;
  if (event?.kind === "series" && req.contentItemId && req.eventId) {
    const ids = (await pool.query(
      "SELECT id FROM content_items WHERE event_id = $1 AND status <> 'cancelled' ORDER BY publish_date NULLS LAST, created_at",
      [req.eventId])).rows.map((r) => r.id);
    const n = ids.indexOf(req.contentItemId);
    if (n !== -1) seriesPosition = { n: n + 1, of: ids.length };
  }

  const prompt = buildDraftPrompt({
    voice: (await getSetting(pool, "house_voice")) || DEFAULT_VOICE,
    context: effective.context, instructions: effective.instructions,
    eventName: event?.name || "", eventKind: event?.kind || "",
    eventDates: event?.startDate ? formatMonthDayYear(event.startDate) + (event.endDate ? " to " + formatMonthDayYear(event.endDate) : "") : "",
    title: req.title, brief: req.brief, phase: req.phase, publishDate: req.publishDate, seriesPosition, source,
    platforms: req.platforms, captionMode: req.captionMode, caption: req.caption, captions: req.captions,
  });

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(stripJsonFences(await callClaude(pool, prompt.system, prompt.user))); }
  catch (e) {
    const msg = (e as Error).message;
    return fail(e instanceof SyntaxError ? "Claude's reply wasn't readable. Try again." : msg);
  }

  if (!parsed || typeof parsed !== "object") return fail("Claude came back without a draft. Try again.");
  const result: DraftResult = { warnings: [], source };
  if (prompt.keys[0] === "post") {
    let caption = typeof parsed.post === "string" ? parsed.post.trim() : "";
    if (!caption) return fail("Claude came back without a draft. Try again.");
    if (req.platforms.includes("x") && overLimit("x", caption)) caption = await shortenForX(pool, caption);
    result.caption = caption;
    result.warnings = req.platforms.map((k) => overLimit(k, caption)).filter(Boolean);
  } else {
    const captions: Record<string, string> = {};
    const missing: string[] = [];
    for (const k of prompt.keys) {
      const v = parsed[k];
      if (typeof v === "string" && v.trim()) captions[k] = v.trim();
      else missing.push(PLATFORMS.find((p) => p.key === k)!.label);
    }
    if (missing.length) return fail(`Claude didn't write the ${missing.join(" and ")} caption. Try again.`);
    if (captions.x && overLimit("x", captions.x)) captions.x = await shortenForX(pool, captions.x);
    result.captions = captions;
    result.warnings = Object.entries(captions).map(([k, v]) => overLimit(k, v)).filter(Boolean);
  }
  if (req.contentItemId) {
    await logDraft(pool, req.contentItemId, { captionMode: req.captionMode, caption: result.caption, captions: result.captions }, createdBy);
  }
  return { ok: true, value: result };
}

/** Draft a saved post and store the result: caption(s), the source it used, and Drafted. */
export async function draftAndSave(pool: Pool, id: string, createdBy: string): Promise<Result<ContentRow>> {
  const item = await getContentRow(pool, id);
  if (!item) return fail("Post not found.");
  const r = await draftCaptions(pool, {
    contentItemId: id, title: item.title, brief: item.brief, phase: item.phase, eventId: item.eventId,
    platforms: item.platforms.length ? item.platforms : DEFAULT_PLATFORMS, publishDate: item.publishDate,
    captionMode: item.captionMode, caption: item.caption, captions: item.captions,
    drafting: item.drafting, sourceRef: item.sourceRef,
  }, createdBy);
  if (!r.ok) return r;
  const s = r.value.source;
  const ref = s && s.kind !== "manual" ? { kind: s.kind, id: s.id, title: s.title, url: s.url, date: s.date } : item.sourceRef;
  await pool.query(
    `UPDATE content_items
        SET caption = COALESCE($2, caption), captions = COALESCE($3, captions), source_ref = $4,
            status = CASE WHEN status IN ('idea','planned') THEN 'drafted' ELSE status END, updated_at = now()
      WHERE id = $1`,
    [id, r.value.caption ?? null, r.value.captions ?? null, ref ?? null],
  );
  return { ok: true, value: (await getContentRow(pool, id))! };
}

/** Draft several saved posts in turn; one failing doesn't stop the rest. */
export async function draftAll(pool: Pool, ids: string[], createdBy: string): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  const out: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      const r = await draftAndSave(pool, id, createdBy);
      out.push(r.ok ? { id, ok: true } : { id, ok: false, error: r.error });
    } catch (e) {
      // A failure anywhere in one post (a retry call, the database) is that post's answer.
      out.push({ id, ok: false, error: (e as Error).message });
    }
  }
  return out;
}
