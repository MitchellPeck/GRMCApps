import { ActionItem } from "./claude";
import { SpeakerMap, resolveSpeakerName } from "./transcript";
import { DiarizedSegment } from "./whisper";

// Correcting a misheard name or word. Matching is whole-word and case-aware:
// "John" never matches inside "Johnson", and "john" is a different word.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A straight and a curly apostrophe are the same letter here: "O'Brien" typed
// in the box should find "O’Brien" in the transcript.
function namePattern(from: string): string {
  return escapeRegex(from).replace(/['’]/g, "['’]");
}

function wordPattern(from: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${namePattern(from)}(?![\\p{L}\\p{N}])`, "gu");
}

export function replaceWords(text: string, from: string, to: string): { text: string; count: number } {
  if (!from || !text) return { text, count: 0 };
  let count = 0;
  // A function replacer, so "$1" or "&" in the replacement is taken literally.
  const out = text.replace(wordPattern(from), () => { count++; return to; });
  return { text: out, count };
}

export function replaceInSegments(
  segs: DiarizedSegment[],
  from: string,
  to: string
): { segments: DiarizedSegment[]; count: number } {
  let count = 0;
  const segments = segs.map((s) => {
    const r = replaceWords(s.text, from, to);
    count += r.count;
    return r.count ? { ...s, text: r.text } : s;
  });
  return { segments, count };
}

export function replaceInActionItems(
  items: ActionItem[],
  from: string,
  to: string,
  fields: Array<"task" | "owner"> = ["task", "owner"]
): { items: ActionItem[]; count: number } {
  let count = 0;
  const out = items.map((a) => {
    const next = { ...a };
    for (const f of fields) {
      const r = replaceWords(a[f], from, to);
      count += r.count;
      next[f] = r.text;
    }
    return next;
  });
  return { items: out, count };
}

// The display names a speaker-map change renames, as old → new. A name another
// voice still goes by after the change is left alone: it still belongs in the
// text.
export function renamedVoices(
  oldMap: SpeakerMap,
  newMap: SpeakerMap,
  order: string[]
): Array<{ from: string; to: string }> {
  const stillUsed = new Set(order.map((l) => resolveSpeakerName(l, newMap, order)));
  const out: Array<{ from: string; to: string }> = [];
  for (const label of order) {
    const from = resolveSpeakerName(label, oldMap, order);
    const to = resolveSpeakerName(label, newMap, order);
    if (from === to || stillUsed.has(from)) continue;
    if (!out.some((p) => p.from === from && p.to === to)) out.push({ from, to });
  }
  return out;
}

// Several whole-word replacements in one pass, so renames can't feed into each
// other (two names can swap). Longer names win where they overlap.
export function replaceMany(text: string, pairs: Array<{ from: string; to: string }>): { text: string; count: number } {
  const usable = pairs.filter((p) => p.from && p.from !== p.to).sort((a, b) => b.from.length - a.from.length);
  if (!usable.length || !text) return { text, count: 0 };
  const key = (x: string) => x.replace(/’/g, "'");
  const to = new Map(usable.map((p) => [key(p.from), p.to]));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${usable.map((p) => namePattern(p.from)).join("|")})(?![\\p{L}\\p{N}])`, "gu");
  let count = 0;
  const out = text.replace(re, (m) => { count++; return to.get(key(m)) ?? m; });
  return { text: out, count };
}
