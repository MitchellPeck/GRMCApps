// Per-platform rules for captions: length as each platform counts it, and the
// one hard rule, that Instagram won't take a post without an image. Pure.
import { PLATFORMS } from "./config";

const URL_RE = /https?:\/\/\S+/g;

/** Caption length as the platform counts it (X charges 23 for any link). */
export function countChars(platform: string, text: string): number {
  const p = PLATFORMS.find((x) => x.key === platform);
  const s = text || "";
  if (!p?.urlLength) return [...s].length;
  const urls = s.match(URL_RE) || [];
  return [...s.replace(URL_RE, "")].length + urls.length * p.urlLength;
}

/** The caption each platform will actually get. */
export function captionFor(
  platform: string, item: { captionMode: string; caption: string; captions: Record<string, string> },
): string {
  return item.captionMode === "separate" ? (item.captions[platform] ?? "") : item.caption;
}

/** "X: 312 of 280 characters" for every selected platform that's over. */
export function captionWarnings(item: {
  platforms: string[]; captionMode: string; caption: string; captions: Record<string, string>;
}): string[] {
  const out: string[] = [];
  for (const key of item.platforms) {
    const p = PLATFORMS.find((x) => x.key === key);
    if (!p) continue;
    const n = countChars(key, captionFor(key, item));
    if (n > p.limit) out.push(`${p.label} caption is ${n} characters; the limit is ${p.limit}.`);
  }
  return out;
}

/** Why this combination can't be saved, or "" if it can. */
export function imageRuleError(platforms: string[], noMediaNeeded: boolean): string {
  if (!noMediaNeeded) return "";
  const blocked = PLATFORMS.filter((p) => p.needsImage && platforms.includes(p.key)).map((p) => p.label);
  if (!blocked.length) return "";
  return `${blocked.join(" and ")} can't take a text-only post; it needs an image. Untick ${blocked.join(" and ")}, or untick “No media needed”.`;
}
