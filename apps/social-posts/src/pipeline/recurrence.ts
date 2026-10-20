// Recurring posts: the repeat rule, the dates it produces and how it reads to
// a person. Pure, so every pattern is unit tested; the generator in
// recurring.ts turns these dates into ordinary content items.
import { addDays } from "../dates";
import { isIsoDate, MEDIA_TYPES, Result } from "./rules";
import { PLATFORMS } from "./config";

export const FREQS = ["weekly", "monthly_date", "monthly_weekday"] as const;
export type Freq = typeof FREQS[number];

export interface Rule {
  freq: Freq;
  /** Every N weeks (weekly) or every N months (monthly). */
  interval: number;
  /** 0 = Sunday … 6 = Saturday. Weekly only. */
  weekdays: number[];
  /** 1–31; months without that day use their last day. monthly_date only. */
  monthDay: number | null;
  /** 1–4, or -1 for "last". monthly_weekday only. */
  nth: number | null;
  /** 0–6. monthly_weekday only. */
  weekday: number | null;
  startDate: string;
  endDate: string | null;
  /** Stop after this many occurrences, counted from startDate. */
  count: number | null;
}

/** Hard stop so a bad rule can never spin. Ten years of weekly posts. */
const MAX_OCCURRENCES = 520;

const dayOf = (iso: string) => new Date(iso + "T12:00:00Z").getUTCDay();
const pad = (n: number) => String(n).padStart(2, "0");
const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

function nthWeekdayOf(y: number, m0: number, nth: number, weekday: number): string | null {
  const dim = daysInMonth(y, m0);
  if (nth === -1) {
    const lastDow = new Date(Date.UTC(y, m0, dim, 12)).getUTCDay();
    return `${y}-${pad(m0 + 1)}-${pad(dim - ((lastDow - weekday + 7) % 7))}`;
  }
  const firstDow = new Date(Date.UTC(y, m0, 1, 12)).getUTCDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
  return day <= dim ? `${y}-${pad(m0 + 1)}-${pad(day)}` : null;
}

/** Every date the rule produces from its start up to `until`, in order. */
export function occurrences(rule: Rule, until: string): string[] {
  const limit = rule.endDate && rule.endDate < until ? rule.endDate : until;
  const out: string[] = [];
  const push = (d: string | null) => {
    if (!d || d < rule.startDate || d > limit) return true;
    out.push(d);
    return !(rule.count != null && out.length >= rule.count) && out.length < MAX_OCCURRENCES;
  };
  const interval = Math.max(1, rule.interval || 1);

  if (rule.freq === "weekly") {
    const days = Array.from(new Set(rule.weekdays)).filter((d) => d >= 0 && d <= 6).sort();
    if (!days.length) return out;
    const weekStart = addDays(rule.startDate, -dayOf(rule.startDate));
    for (let week = 0; ; week += interval) {
      const base = addDays(weekStart, week * 7);
      if (base > limit) break;
      for (const d of days) if (!push(addDays(base, d))) return out;
    }
    return out;
  }

  const [sy, sm] = rule.startDate.split("-").map(Number);
  for (let i = 0; ; i += interval) {
    const y = sy + Math.floor((sm - 1 + i) / 12), m0 = (sm - 1 + i) % 12;
    if (`${y}-${pad(m0 + 1)}-01` > limit) break;
    let date: string | null = null;
    if (rule.freq === "monthly_date" && rule.monthDay) {
      date = `${y}-${pad(m0 + 1)}-${pad(Math.min(rule.monthDay, daysInMonth(y, m0)))}`;
    } else if (rule.freq === "monthly_weekday" && rule.nth != null && rule.weekday != null) {
      date = nthWeekdayOf(y, m0, rule.nth, rule.weekday);
    } else {
      return out;
    }
    if (!push(date)) return out;
  }
  return out;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NTH = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", [-1]: "last" } as Record<number, string>;
function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return n + s;
}
function listOf(names: string[]): string {
  return names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/** "Every Wednesday", "Every 2 weeks on Sunday", "Monthly on the last Friday". */
export function describeRule(rule: Rule): string {
  const n = Math.max(1, rule.interval || 1);
  let s: string;
  if (rule.freq === "weekly") {
    const days = listOf(Array.from(new Set(rule.weekdays)).sort().map((d) => DAY_NAMES[d]));
    s = n === 1 ? `Every ${days}` : `Every ${n} weeks on ${days}`;
  } else {
    const on = rule.freq === "monthly_date"
      ? `the ${ordinal(rule.monthDay || 1)}`
      : `the ${NTH[rule.nth ?? 1]} ${DAY_NAMES[rule.weekday ?? 0]}`;
    s = n === 1 ? `Monthly on ${on}` : `Every ${n} months on ${on}`;
  }
  if (rule.endDate) s += `, until ${rule.endDate}`;
  else if (rule.count) s += `, ${rule.count} times`;
  return s;
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface MediaTemplateItem {
  description: string; type: string; assigneeEmail: string;
  /** Gather this many days before (negative) or after the post. */
  offsetDays: number;
}

export interface RecurrenceInput {
  title?: string; brief?: string; eventId?: string | null; platforms?: string[];
  publishTime?: string | null; ownerEmail?: string; noMediaNeeded?: boolean;
  mediaTemplate?: MediaTemplateItem[]; active?: boolean;
  rule?: Rule;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export function parseRule(raw: unknown): Result<Rule> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  if (!(FREQS as readonly string[]).includes(r.freq)) return fail("Choose how often it repeats.");
  const interval = r.interval == null ? 1 : r.interval;
  if (!isInt(interval, 1, 52)) return fail("Repeat every 1 to 52 weeks or months.");
  if (!isIsoDate(r.startDate)) return fail("Pick the date it starts.");
  const endDate = r.endDate || null;
  if (endDate && (!isIsoDate(endDate) || endDate < r.startDate)) return fail("The end date must be a date after the start.");
  const count = r.count == null || r.count === "" ? null : r.count;
  if (count != null && !isInt(count, 1, MAX_OCCURRENCES)) return fail(`Repeat between 1 and ${MAX_OCCURRENCES} times.`);
  const rule: Rule = {
    freq: r.freq, interval, startDate: r.startDate, endDate, count,
    weekdays: [], monthDay: null, nth: null, weekday: null,
  };
  if (r.freq === "weekly") {
    if (!Array.isArray(r.weekdays) || !r.weekdays.length || !r.weekdays.every((d: unknown) => isInt(d, 0, 6))) {
      return fail("Pick at least one day of the week.");
    }
    rule.weekdays = Array.from(new Set(r.weekdays as number[])).sort();
  } else if (r.freq === "monthly_date") {
    if (!isInt(r.monthDay, 1, 31)) return fail("Pick a day of the month from 1 to 31.");
    rule.monthDay = r.monthDay;
  } else {
    if (![1, 2, 3, 4, -1].includes(r.nth)) return fail("Pick 1st, 2nd, 3rd, 4th or last.");
    if (!isInt(r.weekday, 0, 6)) return fail("Pick a day of the week.");
    rule.nth = r.nth; rule.weekday = r.weekday;
  }
  return { ok: true, value: rule };
}

export function parseRecurrenceInput(raw: unknown, mode: "create" | "patch"): Result<RecurrenceInput> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const out: RecurrenceInput = {};
  if ("title" in b) {
    if (typeof b.title !== "string" || !b.title.trim()) return fail("Give the recurring post a title.");
    out.title = b.title.trim().slice(0, 300);
  } else if (mode === "create") return fail("Give the recurring post a title.");
  if ("brief" in b) out.brief = String(b.brief ?? "").trim();
  if ("eventId" in b) out.eventId = b.eventId || null;
  if ("platforms" in b) {
    const known = PLATFORMS.map((p) => p.key);
    if (!Array.isArray(b.platforms) || b.platforms.some((p: unknown) => typeof p !== "string" || !known.includes(p))) {
      return fail(`Platforms must be chosen from: ${known.join(", ")}.`);
    }
    out.platforms = Array.from(new Set(b.platforms as string[]));
  }
  if ("publishTime" in b) {
    const t = b.publishTime;
    if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return fail("Publish time must look like 09:30.");
    out.publishTime = t || null;
  }
  if ("ownerEmail" in b) {
    const e = String(b.ownerEmail ?? "").trim().toLowerCase();
    if (e && !/^[^\s@]+@[^\s@]+$/.test(e)) return fail("Owner must be an email address.");
    out.ownerEmail = e;
  }
  if ("noMediaNeeded" in b) out.noMediaNeeded = !!b.noMediaNeeded;
  if ("active" in b) out.active = !!b.active;
  if ("mediaTemplate" in b) {
    if (!Array.isArray(b.mediaTemplate)) return fail("The media list is malformed.");
    const items: MediaTemplateItem[] = [];
    for (const m of b.mediaTemplate) {
      const description = String(m?.description ?? "").trim();
      if (!description) continue;
      if (!(MEDIA_TYPES as readonly string[]).includes(m.type)) return fail(`Media type must be one of: ${MEDIA_TYPES.join(", ")}.`);
      const offsetDays = m.offsetDays == null || m.offsetDays === "" ? 0 : Number(m.offsetDays);
      if (!isInt(offsetDays, -90, 30)) return fail("Gather between 90 days before and 30 days after the post.");
      const assigneeEmail = String(m.assigneeEmail ?? "").trim().toLowerCase();
      if (assigneeEmail && !/^[^\s@]+@[^\s@]+$/.test(assigneeEmail)) return fail("Assignee must be an email address.");
      items.push({ description: description.slice(0, 500), type: m.type, assigneeEmail, offsetDays });
    }
    out.mediaTemplate = items;
  }
  if ("rule" in b || mode === "create") {
    const rule = parseRule(b.rule);
    if (!rule.ok) return rule;
    out.rule = rule.value;
  }
  return { ok: true, value: out };
}
