// Draft captions with Claude, in the same house voice the automated runs use.
// Works from what's in the editor (saved or not), so a brand-new post can be
// drafted before it's created. Returns text; saving it is the person's call.
import { Pool } from "pg";
import { callClaude, stripJsonFences } from "../claude";
import { VOICE } from "../voice";
import { formatMonthDayYear } from "../dates";
import { DEFAULT_PLATFORMS, PLATFORMS } from "./config";
import { countChars } from "./platforms";
import { Result } from "./rules";

export interface DraftRequest {
  title: string; brief: string; eventId: string | null; platforms: string[]; publishDate: string | null;
  captionMode: "same" | "separate"; caption: string; captions: Record<string, string>;
}
export interface DraftResult { caption?: string; captions?: Record<string, string>; warnings: string[] }

const SYS = "You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. "
  + "Return ONLY a JSON object, no markdown fences, just valid JSON.";

export function parseDraftRequest(raw: unknown): Result<DraftRequest> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const known = PLATFORMS.map((p) => p.key);
  const platforms = Array.isArray(b.platforms) ? b.platforms.filter((p: unknown) => known.includes(p as string)) : [];
  const title = String(b.title ?? "").trim(), brief = String(b.brief ?? "").trim();
  if (!title && !brief) return { ok: false, error: "Write a title or a brief first so there's something to draft from." };
  return { ok: true, value: {
    title, brief, eventId: b.eventId || null,
    platforms: platforms.length ? platforms : DEFAULT_PLATFORMS,
    publishDate: typeof b.publishDate === "string" && b.publishDate ? b.publishDate : null,
    captionMode: b.captionMode === "separate" ? "separate" : "same",
    caption: String(b.caption ?? ""),
    captions: b.captions && typeof b.captions === "object" ? b.captions : {},
  } };
}

function overLimit(key: string, text: string): string {
  const p = PLATFORMS.find((x) => x.key === key)!;
  const n = countChars(key, text);
  return n > p.limit ? `${p.label} draft is ${n} characters; the limit is ${p.limit}. Trim it before sending.` : "";
}

export async function draftCaptions(pool: Pool, req: DraftRequest): Promise<Result<DraftResult>> {
  const event = req.eventId
    ? (await pool.query("SELECT name, kind, notes, start_date::text, end_date::text FROM events WHERE id = $1", [req.eventId])).rows[0]
    : null;
  const selected = PLATFORMS.filter((p) => req.platforms.includes(p.key));
  const context = [
    "--- CONTEXT ---",
    "POST TITLE: " + (req.title || "(none)"),
    "BRIEF (purpose, angle, call to action): " + (req.brief || "(none — work from the title)"),
    "PUBLISH DATE: " + (req.publishDate ? formatMonthDayYear(req.publishDate) : "not set"),
  ];
  if (event) {
    context.push("EVENT/DEPARTMENT: " + event.name + " (" + event.kind + ")");
    if (event.start_date) context.push("EVENT DATES: " + formatMonthDayYear(event.start_date) + (event.end_date ? " to " + formatMonthDayYear(event.end_date) : ""));
    if (event.notes) context.push("EVENT NOTES AND KEY MESSAGES: " + event.notes);
  }

  try {
    if (req.captionMode === "separate") {
      const lines = [`Draft one GRMC post for each of these platforms: ${selected.map((p) => p.label).join(", ")}.`,
        "Same message, written natively for each platform.", "", VOICE, "", ...context, "", "--- PLATFORMS ---",
        ...selected.map((p) => p.guidance)];
      const current = selected.filter((p) => req.captions[p.key]);
      if (current.length) {
        lines.push("", "CURRENT DRAFTS (improve on them, keep what works):");
        for (const p of current) lines.push(`${p.label.toUpperCase()}: ${req.captions[p.key]}`);
      }
      const keys = selected.map((p) => `"${p.key}"`).join(", ");
      const sys = SYS + ` Keys: ${keys}, each a string holding that platform's post.`;
      let captions = pickKeys(JSON.parse(stripJsonFences(await callClaude(pool, sys, lines.join("\n")))), selected.map((p) => p.key));

      // One retry for X if it ran long; Claude counts characters loosely.
      if (captions.x && overLimit("x", captions.x)) {
        const retry = JSON.parse(stripJsonFences(await callClaude(pool, SYS + ' Key: "x".',
          `Shorten this X post to at most 250 characters (links count as 23), keeping its point and any link:\n\n${captions.x}`)));
        if (typeof retry.x === "string" && retry.x.trim()) captions = { ...captions, x: retry.x.trim() };
      }
      const warnings = Object.entries(captions).map(([k, v]) => overLimit(k, v)).filter(Boolean);
      return { ok: true, value: { captions, warnings } };
    }

    // One caption for every platform: it has to fit the tightest of them.
    const strictest = selected.reduce((a, p) => (p.limit < a.limit ? p : a), selected[0] || PLATFORMS[0]);
    const lines = ["Draft one GRMC social media post that will go out unchanged on: " + selected.map((p) => p.label).join(", ") + ".",
      "", VOICE, "", ...context];
    if (strictest.key === "x") lines.push("", "It must fit X: at most 280 characters, any link counting as 23.");
    if (selected.some((p) => p.key === "instagram")) lines.push("It goes under an image on Instagram, where links aren't clickable; if there's a link, also say where to find it.");
    if (req.caption) lines.push("", "CURRENT DRAFT (improve on it, keep what works):", req.caption);
    let caption = String(JSON.parse(stripJsonFences(await callClaude(pool, SYS + ' Key: "post".', lines.join("\n")))).post || "").trim();
    if (!caption) return { ok: false, error: "Claude came back without a draft. Try again." };
    if (strictest.key === "x" && overLimit("x", caption)) {
      const retry = JSON.parse(stripJsonFences(await callClaude(pool, SYS + ' Key: "post".',
        `Shorten this post to at most 250 characters (links count as 23), keeping its point and any link:\n\n${caption}`)));
      if (typeof retry.post === "string" && retry.post.trim()) caption = retry.post.trim();
    }
    const warnings = selected.map((p) => overLimit(p.key, caption)).filter(Boolean);
    return { ok: true, value: { caption, warnings } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function pickKeys(obj: Record<string, unknown>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) if (typeof obj?.[k] === "string" && (obj[k] as string).trim()) out[k] = (obj[k] as string).trim();
  if (!Object.keys(out).length) throw new Error("Claude came back without drafts. Try again.");
  return out;
}
