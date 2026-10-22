// One prompt for every kind of post: house voice, the event's background,
// the instructions in force, the post itself, the source material, and how
// each platform wants it. Pure, so tests can hold the wording steady.
import { formatMonthDayYear } from "../dates";
import { PLATFORMS } from "./config";

export interface SourceContent {
  kind: "mailchimp" | "buzzsprout" | "manual" | "sermon";
  id: string; title: string; url: string; date: string; dateLine: string; content: string;
  isDraft?: boolean; notYetPublic?: boolean; durationLabel?: string;
  /** A podcast episode's transcript, once its audio has been transcribed. */
  transcript?: string;
  /** Where the episode's transcription is: its recording's id and state. */
  audio?: { id: string; status: string; progress: string; error: string };
}

export interface PromptInput {
  voice: string; context: string; instructions: string;
  eventName: string; eventKind: string; eventDates: string;
  title: string; brief: string; phase: string; publishDate: string | null;
  seriesPosition: { n: number; of: number } | null;
  source: SourceContent | null;
  platforms: string[]; captionMode: "same" | "separate"; caption: string; captions: Record<string, string>;
}

const SYS = "You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. "
  + "Return ONLY a JSON object, no markdown fences, just valid JSON. "
  + "Always write the post, even with little to go on: work from the title, event, source and instructions, "
  + "and never answer with questions or notes instead of a post.";

export function buildDraftPrompt(p: PromptInput): { system: string; user: string; keys: string[] } {
  const selected = PLATFORMS.filter((x) => p.platforms.includes(x.key));
  const separate = p.captionMode === "separate" && selected.length > 0;
  const lines: string[] = [
    separate
      ? `Draft one GRMC post for each of these platforms: ${selected.map((x) => x.label).join(", ")}. Same message, written natively for each platform.`
      : "Draft one GRMC social media post that will go out unchanged on: " + (selected.map((x) => x.label).join(", ") || "Instagram, Facebook") + ".",
    "", p.voice, "", "--- CONTEXT ---",
    "POST TITLE: " + (p.title || "(none)"),
    "BRIEF: " + (p.brief || "(none — work from the title and source)"),
    "PUBLISH DATE: " + (p.publishDate ? formatMonthDayYear(p.publishDate) : "not set"),
  ];
  if (p.eventName) lines.push(`EVENT/DEPARTMENT: ${p.eventName}${p.eventKind ? ` (${p.eventKind})` : ""}`);
  if (p.eventDates) lines.push("EVENT DATES: " + p.eventDates);
  if (p.context) lines.push("BACKGROUND AND KEY MESSAGES: " + p.context);
  if (p.seriesPosition) lines.push(`THIS POST: ${p.seriesPosition.n} of ${p.seriesPosition.of}`);
  if (p.phase) lines.push("PHASE: " + p.phase);

  const s = p.source;
  if (s && s.kind === "sermon") {
    // Any video: a sermon, a testimony, an event clip. The event's notes and the
    // instructions say what it is; the file name is only a hint.
    lines.push("", "--- SOURCE ---", "VIDEO: " + (s.title || "(untitled)") + (s.dateLine ? ` (${s.dateLine})` : ""),
      "This post goes out with or about this video. The caption should fit what is said in it.",
      "This is an automatic transcript: names, places and scripture references may be misheard. Don't quote a verse reference unless it's clear from the text.",
      "", "VIDEO TRANSCRIPT:", s.content || "(not provided)");
  } else if (s && s.kind === "buzzsprout") {
    lines.push("", "--- SOURCE ---", "EPISODE TITLE: " + (s.title || "(not available)"), "LISTEN URL: " + (s.url || "(not provided)"));
    if (s.durationLabel) lines.push("EPISODE LENGTH: " + s.durationLabel);
    if (s.notYetPublic) lines.push("NOT YET PUBLIC: this episode is " + s.dateLine + ". Write as though it is landing, not as though it is already out.");
    lines.push("", "EPISODE DESCRIPTION:", s.content || "(not provided)");
    if (s.transcript) {
      lines.push("", "EPISODE TRANSCRIPT (automatic: names, places and scripture references may be misheard; "
        + "where the description spells something, trust the description):", s.transcript);
    }
  } else if (s) {
    lines.push("", "--- SOURCE ---", "SOURCE: " + (s.title || "(untitled)") + (s.isDraft ? " (this issue has not been sent yet; don't describe it as already out)" : ""),
      "SOURCE URL: " + (s.url || "(not provided)"), "", "SOURCE CONTENT:", s.content || "(not provided)");
  }

  // Platform notes and current drafts come before the instructions, so the
  // instructions are the last word (as they were in the old weekly runs).
  let keys: string[];
  if (separate) {
    keys = selected.map((x) => x.key);
    lines.push("", "--- PLATFORMS ---", ...selected.map((x) => x.guidance));
    const current = selected.filter((x) => p.captions[x.key]);
    if (current.length) {
      lines.push("", "CURRENT DRAFTS (improve on them, keep what works):");
      for (const x of current) lines.push(`${x.label.toUpperCase()}: ${p.captions[x.key]}`);
    }
  } else {
    // One text goes everywhere, so no single platform's habits (like
    // Instagram's "link in bio") get to override the instructions.
    keys = ["post"];
    if (selected.some((x) => x.key === "x")) lines.push("", "It must fit X: at most 280 characters, any link counting as 23.");
    if (p.caption) lines.push("", "CURRENT DRAFT (improve on it, keep what works):", p.caption);
  }
  lines.push("", "--- WHAT TO WRITE ---", p.instructions);
  const system = SYS + ` Keys: ${keys.map((k) => `"${k}"`).join(", ")}, each a string holding that post's text.`;
  return { system, user: lines.join("\n"), keys };
}
