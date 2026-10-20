// The pipeline's rules, all pure so they can be unit tested: input validation,
// the media gather-date rule, the Ready gate, the legacy series-status mapping
// and the five gap alerts. The routes and repo only ever call into here, so a
// status or date the server accepts is exactly what these functions accept.
import { addDays } from "../dates";
import { PLATFORMS } from "./config";
import { Override, Profile, SourceRef, parseOverride, parseProfile, parseSourceRef } from "./drafting";

export const CONTENT_STATUSES = ["idea", "planned", "drafted", "ready", "scheduled", "published", "cancelled"] as const;
export const MEDIA_STATUSES = ["needed", "scheduled", "captured", "edited"] as const;
export const MEDIA_TYPES = ["photo", "video", "graphic", "audio", "interview", "other"] as const;
export const EVENT_KINDS = ["event", "department", "series"] as const;

export type ContentStatus = typeof CONTENT_STATUSES[number];
export type MediaStatus = typeof MEDIA_STATUSES[number];

/** Statuses that count as "ready" for gap alert 1. */
export const READY_STATUSES: ContentStatus[] = ["ready", "scheduled", "published"];
/** Statuses a person can only choose once the post's media is in hand. */
export const GATED_STATUSES: ContentStatus[] = ["ready", "scheduled"];
/** Media that is in hand. */
export const DONE_MEDIA: MediaStatus[] = ["captured", "edited"];

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// ── Field parsers ────────────────────────────────────────────────────────────

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isTime(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s);
}

// A nullable date: "" and null both mean "no date".
function optDate(body: Record<string, unknown>, key: string, label: string): Result<string | null> | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null || v === "") return { ok: true, value: null };
  if (!isIsoDate(v)) return fail(`${label} must be a date like 2026-11-01.`);
  return { ok: true, value: v };
}

function optText(body: Record<string, unknown>, key: string, label: string, max = 20000): Result<string> | undefined {
  if (!(key in body)) return undefined;
  const v = body[key] ?? "";
  if (typeof v !== "string") return fail(`${label} must be text.`);
  if (v.length > max) return fail(`${label} is too long.`);
  return { ok: true, value: v.trim() };
}

function optEnum<T extends string>(body: Record<string, unknown>, key: string, label: string, allowed: readonly T[]): Result<T> | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    return fail(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return { ok: true, value: v as T };
}

function optBool(body: Record<string, unknown>, key: string, label: string): Result<boolean> | undefined {
  if (!(key in body)) return undefined;
  if (typeof body[key] !== "boolean") return fail(`${label} must be true or false.`);
  return { ok: true, value: body[key] as boolean };
}

function optEmail(body: Record<string, unknown>, key: string, label: string): Result<string> | undefined {
  const r = optText(body, key, label, 320);
  if (!r || !r.ok) return r;
  if (r.value && !/^[^\s@]+@[^\s@]+$/.test(r.value)) return fail(`${label} must be an email address.`);
  return { ok: true, value: r.value.toLowerCase() };
}

// Collects each parsed field into `out`, stopping at the first error.
function collect(out: Record<string, unknown>, fields: Array<[string, Result<unknown> | undefined]>): string | null {
  for (const [key, r] of fields) {
    if (!r) continue;
    if (!r.ok) return r.error;
    out[key] = r.value;
  }
  return null;
}

function asBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

// ── Content items ────────────────────────────────────────────────────────────

export const CAPTION_MODES = ["same", "separate"] as const;

export interface ContentInput {
  title?: string; eventId?: string | null; platforms?: string[];
  publishDate?: string | null; publishTime?: string | null; status?: ContentStatus;
  ownerEmail?: string; brief?: string; caption?: string; noMediaNeeded?: boolean;
  /** "same": `caption` goes everywhere. "separate": `captions[platform]` each. */
  captionMode?: typeof CAPTION_MODES[number];
  captions?: Record<string, string>;
  drafting?: Override; sourceRef?: SourceRef | null; phase?: string;
}

export function parseContentInput(raw: unknown, mode: "create" | "patch"): Result<ContentInput> {
  const body = asBody(raw);
  const out: Record<string, unknown> = {};

  let platforms: Result<string[]> | undefined;
  if ("platforms" in body) {
    const p = body.platforms;
    const known = PLATFORMS.map((x) => x.key);
    if (!Array.isArray(p) || p.some((x) => typeof x !== "string" || !known.includes(x))) {
      platforms = fail(`Platforms must be chosen from: ${known.join(", ")}.`);
    } else {
      platforms = { ok: true, value: Array.from(new Set(p as string[])) };
    }
  }

  let eventId: Result<string | null> | undefined;
  if ("eventId" in body) {
    const e = body.eventId;
    eventId = e === null || e === "" ? { ok: true, value: null }
      : typeof e === "string" ? { ok: true, value: e } : fail("Event must be an id.");
  }

  let publishTime: Result<string | null> | undefined;
  if ("publishTime" in body) {
    const t = body.publishTime;
    publishTime = t === null || t === "" ? { ok: true, value: null }
      : isTime(t) ? { ok: true, value: t } : fail("Publish time must look like 09:30.");
  }

  let captions: Result<Record<string, string>> | undefined;
  if ("captions" in body) {
    const c = body.captions;
    const known = PLATFORMS.map((x) => x.key);
    if (!c || typeof c !== "object" || Array.isArray(c)
        || Object.entries(c).some(([k, v]) => !known.includes(k) || typeof v !== "string" || v.length > 20000)) {
      captions = fail("Each platform's caption must be text.");
    } else {
      captions = { ok: true, value: Object.fromEntries(Object.entries(c as Record<string, string>).map(([k, v]) => [k, v.trim()])) };
    }
  }

  const err = collect(out, [
    ["title", optText(body, "title", "Title", 300)],
    ["eventId", eventId],
    ["captionMode", optEnum(body, "captionMode", "Caption mode", CAPTION_MODES)],
    ["captions", captions],
    ["drafting", "drafting" in body ? parseOverride(body.drafting) : undefined],
    ["sourceRef", "sourceRef" in body ? parseSourceRef(body.sourceRef) : undefined],
    ["phase", optText(body, "phase", "Phase", 200)],
    ["platforms", platforms],
    ["publishDate", optDate(body, "publishDate", "Publish date")],
    ["publishTime", publishTime],
    ["status", optEnum(body, "status", "Status", CONTENT_STATUSES)],
    ["ownerEmail", optEmail(body, "ownerEmail", "Owner")],
    ["brief", optText(body, "brief", "Brief")],
    ["caption", optText(body, "caption", "Caption")],
    ["noMediaNeeded", optBool(body, "noMediaNeeded", "No media needed")],
  ]);
  if (err) return fail(err);
  if ("title" in out && !out.title) return fail("Give the post a title.");
  if (mode === "create") {
    if (!out.title) return fail("Give the post a title.");
    if (!out.publishDate) return fail("Pick a publish date.");
  }
  return { ok: true, value: out as ContentInput };
}

// ── Media assets ─────────────────────────────────────────────────────────────

export interface MediaInput {
  description?: string; type?: string; gatherDate?: string | null; gatherLocation?: string;
  assigneeEmail?: string; status?: MediaStatus; fileLink?: string; notes?: string;
  /** A finished file chosen from the Approvals app; null clears it. */
  approvalId?: number | null; approvalTitle?: string;
  /** An uploaded file's original name and kind ("image" | "video"); "" when the link was pasted. */
  fileName?: string; fileType?: string;
  /** "collect" (a thing to gather) or "attachment" (a file added straight to the post). */
  kind?: "collect" | "attachment"; position?: number;
}

export function parseMediaInput(raw: unknown, mode: "create" | "patch"): Result<MediaInput> {
  const body = asBody(raw);
  const out: Record<string, unknown> = {};
  let approvalId: Result<number | null> | undefined;
  if ("approvalId" in body) {
    const a = body.approvalId;
    approvalId = a === null || a === "" ? { ok: true, value: null }
      : Number.isInteger(Number(a)) && Number(a) > 0 ? { ok: true, value: Number(a) } : fail("That approved file isn't valid.");
  }
  const err = collect(out, [
    ["approvalId", approvalId],
    ["approvalTitle", optText(body, "approvalTitle", "Approved file title", 300)],
    ["fileName", optText(body, "fileName", "File name", 200)],
    ["kind", optEnum(body, "kind", "Media kind", ["collect", "attachment"] as const)],
    ["position", "position" in body ? (Number.isInteger(body.position) ? { ok: true, value: body.position as number } : fail("Position must be a whole number.")) : undefined],
    ["fileType", "fileType" in body ? (["", "image", "video"].includes(body.fileType as string)
      ? { ok: true, value: body.fileType as string } : fail("File type must be image or video.")) : undefined],
    ["description", optText(body, "description", "Description", 500)],
    ["type", optEnum(body, "type", "Media type", MEDIA_TYPES)],
    ["gatherDate", optDate(body, "gatherDate", "Gather date")],
    ["gatherLocation", optText(body, "gatherLocation", "Location", 300)],
    ["assigneeEmail", optEmail(body, "assigneeEmail", "Assignee")],
    ["status", optEnum(body, "status", "Media status", MEDIA_STATUSES)],
    ["fileLink", optText(body, "fileLink", "File link", 2000)],
    ["notes", optText(body, "notes", "Notes")],
  ]);
  if (err) return fail(err);
  if (typeof out.fileLink === "string" && out.fileLink && !/^https?:\/\//i.test(out.fileLink)) {
    return fail("File link must start with http:// or https://.");
  }
  // An attachment is named after its file (createMedia sees to that), so only
  // things to collect need a description.
  if (("description" in out || (mode === "create" && out.kind !== "attachment")) && !out.description) return fail("Describe what needs collecting.");
  return { ok: true, value: out as MediaInput };
}

/**
 * The gather-date rule: setting a date moves Needed → Scheduled, clearing it
 * moves Scheduled → Needed. An explicit status in the same change wins, except
 * that Scheduled needs a date to mean anything.
 */
export function resolveMediaStatus(
  current: { status: MediaStatus; gatherDate: string | null; fileLink?: string; approvalId?: number | null },
  patch: MediaInput,
): Result<MediaStatus> {
  const gatherDate = "gatherDate" in patch ? patch.gatherDate ?? null : current.gatherDate;
  if (patch.status) {
    if (patch.status === "scheduled" && !gatherDate) return fail("Set a gather date to mark this media scheduled.");
    return { ok: true, value: patch.status };
  }
  // Attaching the finished file (from Approvals, or a link) means it's done;
  // taking it away again leaves it collected, not un-collected.
  const hadFile = !!(current.fileLink || current.approvalId);
  const hasFile = !!(("fileLink" in patch ? patch.fileLink : current.fileLink)
    || ("approvalId" in patch ? patch.approvalId : current.approvalId));
  if (hasFile && !hadFile) return { ok: true, value: "edited" };
  if (!hasFile && hadFile && current.status === "edited") return { ok: true, value: "captured" };
  if (gatherDate && current.status === "needed") return { ok: true, value: "scheduled" };
  if (!gatherDate && current.status === "scheduled") return { ok: true, value: "needed" };
  return { ok: true, value: current.status };
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface EventInput {
  name?: string; kind?: string; color?: string; startDate?: string | null; endDate?: string | null;
  ownerEmail?: string; notes?: string; archived?: boolean;
  drafting?: Profile;
}

export function parseEventInput(raw: unknown, mode: "create" | "patch"): Result<EventInput> {
  const body = asBody(raw);
  const out: Record<string, unknown> = {};
  let color: Result<string> | undefined;
  if ("color" in body) {
    color = typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color)
      ? { ok: true, value: body.color } : fail("Colour must be a hex value like #092D3E.");
  }
  const err = collect(out, [
    ["name", optText(body, "name", "Name", 200)],
    ["kind", optEnum(body, "kind", "Kind", EVENT_KINDS)],
    ["color", color],
    ["startDate", optDate(body, "startDate", "Start date")],
    ["endDate", optDate(body, "endDate", "End date")],
    ["ownerEmail", optEmail(body, "ownerEmail", "Owner")],
    ["notes", optText(body, "notes", "Notes")],
    ["archived", optBool(body, "archived", "Archived")],
    ["drafting", "drafting" in body ? parseProfile(body.drafting) : undefined],
  ]);
  if (err) return fail(err);
  if (("name" in out || mode === "create") && !out.name) return fail("Give the event a name.");
  if (out.startDate && out.endDate && (out.endDate as string) < (out.startDate as string)) {
    return fail("The end date is before the start date.");
  }
  return { ok: true, value: out as EventInput };
}

// ── The Ready gate ───────────────────────────────────────────────────────────

export interface GateMedia { id: string; description: string; status: MediaStatus }

/** Why a post can't be Ready yet; empty when nothing blocks it. */
export function readyBlockers(item: { noMediaNeeded: boolean }, media: GateMedia[]): string[] {
  if (item.noMediaNeeded) return [];
  if (!media.length) return ["No media is listed. Add what this post needs, or tick “No media needed”."];
  return media
    .filter((m) => !DONE_MEDIA.includes(m.status))
    .map((m) => `${m.description} (${m.status})`);
}

export function checkStatusChange(
  next: ContentStatus, item: { noMediaNeeded: boolean }, media: GateMedia[],
): Result<ContentStatus> {
  if (!GATED_STATUSES.includes(next)) return { ok: true, value: next };
  const blockers = readyBlockers(item, media);
  if (!blockers.length) return { ok: true, value: next };
  return fail(`Not ready yet. Still waiting on: ${blockers.join("; ")}`);
}

// ── Legacy series-post status mapping ────────────────────────────────────────

export function seriesStatusToPipeline(legacy: string): ContentStatus {
  if (legacy === "posted") return "published";
  if (legacy === "drafted") return "drafted";
  return "idea";
}

// ── Gap alerts ───────────────────────────────────────────────────────────────

export interface GapItem {
  id: string; publishDate: string | null; status: ContentStatus; noMediaNeeded: boolean; mediaCount: number;
}
export interface GapMedia {
  id: string; contentItemId: string; gatherDate: string | null; status: MediaStatus;
  itemPublishDate: string | null; itemStatus: ContentStatus;
}
export interface Gap {
  key: string; label: string; kind: "content" | "media"; count: number; ids: string[];
}

const CLOSED: ContentStatus[] = ["published", "cancelled"];
const OPEN_MEDIA: MediaStatus[] = ["needed", "scheduled"];

export function computeGaps(
  items: GapItem[], media: GapMedia[], today: string,
  t: { readinessDays: number; unscheduledMediaDays: number },
): Gap[] {
  const readyBy = addDays(today, t.readinessDays);
  const mediaBy = addDays(today, t.unscheduledMediaDays);
  const within = (d: string | null, until: string) => !!d && d >= today && d <= until;
  const live = (s: ContentStatus) => s !== "cancelled";

  const notReady = items.filter((i) => live(i.status) && within(i.publishDate, readyBy) && !READY_STATUSES.includes(i.status));
  // Past posts nobody planned media for are history, not a gap.
  const noMedia = items.filter((i) => !CLOSED.includes(i.status) && !i.noMediaNeeded && i.mediaCount === 0
    && (!i.publishDate || i.publishDate >= today));
  const unscheduled = media.filter((m) => live(m.itemStatus) && !m.gatherDate && m.status === "needed"
    && within(m.itemPublishDate, mediaBy));
  const late = media.filter((m) => !CLOSED.includes(m.itemStatus) && OPEN_MEDIA.includes(m.status)
    && !!m.gatherDate && !!m.itemPublishDate && m.gatherDate > m.itemPublishDate);
  const overdue = media.filter((m) => live(m.itemStatus) && OPEN_MEDIA.includes(m.status)
    && !!m.gatherDate && m.gatherDate < today);

  const gap = (key: string, label: string, kind: Gap["kind"], rows: { id: string }[]): Gap =>
    ({ key, label, kind, count: rows.length, ids: rows.map((r) => r.id) });
  return [
    gap("not-ready", `Posts publishing within ${t.readinessDays} days that aren't ready`, "content", notReady),
    gap("no-media", "Posts with no media planned", "content", noMedia),
    gap("unscheduled-media", `Media with no gather date for posts in the next ${t.unscheduledMediaDays} days`, "media", unscheduled),
    gap("late-media", "Media gathered after its post publishes", "media", late),
    gap("overdue-media", "Media past its gather date and not collected", "media", overdue),
  ];
}

/** The save-time warning: media gathered after its post goes out. */
export function lateMediaWarning(gatherDate: string | null, publishDate: string | null): string {
  if (gatherDate && publishDate && gatherDate > publishDate) {
    return `Gather date ${gatherDate} is after the post's publish date ${publishDate}.`;
  }
  return "";
}
