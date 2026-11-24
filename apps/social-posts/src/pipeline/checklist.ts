// Checklist rules: pure parsing and resolution. The DB side is checklist-repo.ts.
import { PLATFORMS } from "./config";
import { graphicType } from "./graphic-types";
import { Result } from "./rules";
import { formatMonthDayYear } from "../dates";

export type SeriesMode = "series" | "each" | "ignore" | "single";
export type RuleRepeatMode = Exclude<SeriesMode, "single">;

export type ChecklistItem =
  | { kind: "post"; title: string; platforms: string[]; daysBefore: number }
  | { kind: "graphic"; graphicType: string; daysBefore: number; forPost?: number };

export interface ChecklistRule {
  id: string; match: "calendar" | "name"; calendarId: string | null; namePattern: string;
  effect: "add" | "replace"; repeatMode: RuleRepeatMode | null;
  items: ChecklistItem[]; position: number; active: boolean;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validDays = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

function parseItems(raw: unknown): Result<ChecklistItem[]> {
  if (!Array.isArray(raw)) return fail("Items must be a list.");
  const items: ChecklistItem[] = [];
  for (const [i, r] of raw.entries()) {
    const n = i + 1;
    if (!isObj(r)) return fail(`Item ${n} is not valid.`);
    if (!validDays(r.daysBefore)) return fail(`Item ${n}: days before must be a whole number, 0 or more.`);
    if (r.kind === "post") {
      const title = typeof r.title === "string" ? r.title.trim() : "";
      if (!title) return fail(`Item ${n}: give the post a title.`);
      if (!Array.isArray(r.platforms) || !r.platforms.length) return fail(`Item ${n}: pick at least one platform.`);
      for (const p of r.platforms) {
        if (typeof p !== "string" || !PLATFORMS.some((x) => x.key === p)) return fail(`Item ${n}: unknown platform "${String(p)}".`);
      }
      items.push({ kind: "post", title, platforms: [...new Set(r.platforms as string[])], daysBefore: r.daysBefore });
    } else if (r.kind === "graphic") {
      if (typeof r.graphicType !== "string" || !graphicType(r.graphicType)) return fail(`Item ${n}: unknown graphic type.`);
      const g: ChecklistItem = { kind: "graphic", graphicType: r.graphicType, daysBefore: r.daysBefore };
      if (r.forPost !== undefined && r.forPost !== null) {
        const t = r.forPost;
        if (typeof t !== "number" || !Number.isInteger(t) || t < 0 || t >= raw.length
          || !isObj(raw[t]) || (raw[t] as Record<string, unknown>).kind !== "post") {
          return fail(`Item ${n}: a graphic can only go with a post item.`);
        }
        g.forPost = t;
      }
      items.push(g);
    } else return fail(`Item ${n}: must be a post or a graphic.`);
  }
  return { ok: true, value: items };
}

export function parseRuleInput(raw: unknown, mode: "create" | "patch"): Result<Partial<ChecklistRule>> {
  if (!isObj(raw)) return fail("Send the rule as an object.");
  const create = mode === "create";
  const out: Partial<ChecklistRule> = {};
  if (create || "match" in raw) {
    if (raw.match !== "calendar" && raw.match !== "name") return fail("Match by calendar or by name.");
    out.match = raw.match;
  }
  if ("calendarId" in raw) {
    out.calendarId = typeof raw.calendarId === "string" && raw.calendarId.trim() ? raw.calendarId.trim() : null;
  }
  if ("namePattern" in raw) {
    if (typeof raw.namePattern !== "string") return fail("The name pattern must be text.");
    out.namePattern = raw.namePattern.trim();
  }
  if (create || "effect" in raw) {
    if (raw.effect === undefined && create) out.effect = "add";
    else if (raw.effect === "add" || raw.effect === "replace") out.effect = raw.effect;
    else return fail("Effect must be add or replace.");
  }
  if ("repeatMode" in raw) {
    if (raw.repeatMode === null || raw.repeatMode === "") out.repeatMode = null;
    else if (raw.repeatMode === "series" || raw.repeatMode === "each" || raw.repeatMode === "ignore") out.repeatMode = raw.repeatMode;
    else return fail("Repeat mode must be series, each or ignore.");
  }
  if (create || "items" in raw) {
    const items = parseItems(raw.items ?? (create ? [] : undefined));
    if (!items.ok) return items;
    out.items = items.value;
  }
  if ("position" in raw) {
    if (typeof raw.position !== "number" || !Number.isInteger(raw.position)) return fail("Position must be a whole number.");
    out.position = raw.position;
  }
  if ("active" in raw) {
    if (typeof raw.active !== "boolean") return fail("Active must be true or false.");
    out.active = raw.active;
  }
  // A patch may change `match` alone, so these checks need the merged rule: the repo repeats them.
  if (create) {
    if (out.match === "calendar" && !out.calendarId) return fail("Pick the calendar this rule is for.");
    if (out.match === "name" && !out.namePattern) return fail("Type the text the event name should contain.");
  } else {
    if (out.match === "calendar" && "calendarId" in raw && !out.calendarId) return fail("Pick the calendar this rule is for.");
    if (out.match === "name" && "namePattern" in raw && !out.namePattern) return fail("Type the text the event name should contain.");
  }
  return { ok: true, value: out };
}

/**
 * Calendar rule(s) first, then name rules in position order. `add` appends,
 * `replace` throws away everything so far. Repeat mode follows the same
 * stacking: the most specific (last) matching rule that sets one wins.
 * Name matching is a literal, case-insensitive "contains" — never a regex.
 */
export function resolveChecklist(
  rules: ChecklistRule[], ev: { calendarId: string; name: string },
): { items: ChecklistItem[]; repeatMode: RuleRepeatMode | null } {
  const name = ev.name.toLowerCase();
  const active = rules.filter((r) => r.active).sort((a, b) => a.position - b.position);
  const matching = [
    ...active.filter((r) => r.match === "calendar" && r.calendarId === ev.calendarId),
    ...active.filter((r) => r.match === "name" && r.namePattern && name.includes(r.namePattern.toLowerCase())),
  ];
  // Each entry remembers the post its graphic was written against, by object identity.
  let entries: Array<{ item: ChecklistItem; orig: ChecklistItem; target: ChecklistItem | null }> = [];
  let repeatMode: RuleRepeatMode | null = null;
  for (const r of matching) {
    if (r.effect === "replace") entries = [];
    for (const it of r.items) {
      const target = it.kind === "graphic" && it.forPost !== undefined ? r.items[it.forPost] ?? null : null;
      entries.push({ item: it, orig: it, target });
    }
    if (r.repeatMode) repeatMode = r.repeatMode;
  }
  const items = entries.map((e): ChecklistItem => {
    if (e.item.kind !== "graphic") return { ...e.item };
    const { forPost: _drop, ...rest } = e.item;
    const idx = e.target && e.target.kind === "post" ? entries.findIndex((x) => x.orig === e.target) : -1;
    return idx >= 0 ? { ...rest, forPost: idx } : rest;
  });
  return { items, repeatMode };
}

/** `{event}` and `{date}` in a post title. */
export function fillTitle(t: string, ev: { name: string; date: string }): string {
  return t.split("{event}").join(ev.name).split("{date}").join(formatMonthDayYear(ev.date));
}
