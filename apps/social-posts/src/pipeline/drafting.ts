// Drafting profiles: what Draft with Claude works from for a post — where its
// source material comes from and what each post should do. An event holds the
// profile; a recurring post or a single post may override its instructions
// and/or source. Pure.
import { Result } from "./rules";

export const SOURCE_KINDS = ["none", "mailchimp", "buzzsprout", "sermon"] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export const CUTOFFS = ["latest", "postDate", "followingSunday"] as const;
export type Cutoff = typeof CUTOFFS[number];

export interface SourceConfig { kind: SourceKind; subjectContains?: string; cutoff?: Cutoff }
export interface Angle { key: string; label: string; instructions: string; offsetDays: number }
export interface Profile { source?: SourceConfig; instructions?: string; angles?: Angle[] }
export interface Override { source?: SourceConfig; instructions?: string }
export interface SourceRef {
  kind: "mailchimp" | "buzzsprout" | "manual" | "sermon";
  id?: string; title?: string; url?: string; date?: string; content?: string;
}
export interface Effective {
  source: SourceConfig; instructions: string; context: string; angles: Angle[];
  from: "post" | "recurrence" | "event" | "default";
}

export const GENERIC_INSTRUCTIONS = "Write one post that serves the brief. Make someone want to act on it.";

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const obj = (raw: unknown): Record<string, any> => (raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, any> : {});

export function parseSource(raw: unknown): Result<SourceConfig> {
  const r = obj(raw);
  if (!(SOURCE_KINDS as readonly string[]).includes(r.kind)) return fail("Source must be none, Mailchimp, Buzzsprout or a sermon recording.");
  if (r.kind !== "mailchimp") return { ok: true, value: { kind: r.kind } };
  const subjectContains = String(r.subjectContains ?? "").trim().toLowerCase();
  if (!subjectContains) return fail("Say which Mailchimp campaigns to use: text their subject contains.");
  if (subjectContains.length > 100) return fail("The subject match is too long.");
  const cutoff = r.cutoff ?? "latest";
  if (!(CUTOFFS as readonly string[]).includes(cutoff)) return fail("Pick which issue to use.");
  return { ok: true, value: { kind: "mailchimp", subjectContains, cutoff } };
}

function parseInstructions(v: unknown): Result<string | undefined> {
  if (v == null) return { ok: true, value: undefined };
  if (typeof v !== "string") return fail("Instructions must be text.");
  if (v.length > 4000) return fail("Instructions are too long.");
  return { ok: true, value: v.trim() || undefined };
}

function parseAngles(v: unknown): Result<Angle[]> {
  if (!Array.isArray(v)) return fail("Angles must be a list.");
  const out: Angle[] = [];
  for (const a of v) {
    const key = String(a?.key ?? "");
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(key)) return fail(`"${key}" can't be an angle key: use lower-case letters, digits and dashes.`);
    if (out.some((x) => x.key === key)) return fail(`Two angles share the key "${key}".`);
    const label = String(a?.label ?? "").trim(), instructions = String(a?.instructions ?? "").trim();
    if (!label || !instructions) return fail("Each angle needs a label and instructions.");
    const offsetDays = Number(a?.offsetDays ?? 0);
    if (!Number.isInteger(offsetDays) || offsetDays < -30 || offsetDays > 60) return fail("Angle days must be between -30 and 60.");
    out.push({ key, label, instructions, offsetDays });
  }
  return { ok: true, value: out };
}

export function parseOverride(raw: unknown): Result<Override> {
  const r = obj(raw), out: Override = {};
  if (r.source != null) {
    const s = parseSource(r.source);
    if (!s.ok) return s;
    out.source = s.value;
  }
  const i = parseInstructions(r.instructions);
  if (!i.ok) return i;
  if (i.value) out.instructions = i.value;
  return { ok: true, value: out };
}

export function parseProfile(raw: unknown): Result<Profile> {
  const base = parseOverride(raw);
  if (!base.ok) return base;
  const out: Profile = { ...base.value };
  const r = obj(raw);
  if (r.angles != null) {
    const a = parseAngles(r.angles);
    if (!a.ok) return a;
    out.angles = a.value;
  }
  return { ok: true, value: out };
}

export function parseSourceRef(raw: unknown): Result<SourceRef | null> {
  if (raw == null) return { ok: true, value: null };
  const r = obj(raw);
  if (!["mailchimp", "buzzsprout", "manual", "sermon"].includes(r.kind)) return fail("That source item isn't valid.");
  const s = (k: string, max: number) => (r[k] == null ? undefined : String(r[k]).slice(0, max));
  const ref: SourceRef = { kind: r.kind, id: s("id", 100), title: s("title", 300), url: s("url", 2000), date: s("date", 10), content: s("content", 20000) };
  if (ref.kind === "manual" && !ref.content?.trim()) return fail("Paste the content to draft from.");
  if (ref.kind !== "manual" && !ref.id) return fail("That source item has no id.");
  for (const k of Object.keys(ref) as (keyof SourceRef)[]) if (ref[k] === undefined) delete ref[k];
  return { ok: true, value: ref };
}

export function effectiveProfile(
  event: { notes: string; drafting: Profile } | null,
  recurrence: { drafting: Override } | null,
  item: { drafting: Override },
): Effective {
  const layers: Array<[Effective["from"], Override | Profile | undefined]> = [
    ["post", item.drafting], ["recurrence", recurrence?.drafting], ["event", event?.drafting],
  ];
  const withInstructions = layers.find(([, d]) => d?.instructions);
  const withSource = layers.find(([, d]) => d?.source);
  return {
    instructions: withInstructions ? withInstructions[1]!.instructions! : GENERIC_INSTRUCTIONS,
    from: withInstructions ? withInstructions[0] : "default",
    source: withSource ? withSource[1]!.source! : { kind: "none" },
    context: event?.notes || "",
    angles: event?.drafting?.angles || [],
  };
}
