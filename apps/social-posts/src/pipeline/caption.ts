// Draft a caption for a hand-planned post, in the same house voice the
// automated runs use. Returns the text; saving it is the person's call.
import { Pool } from "pg";
import { callClaude, stripJsonFences } from "../claude";
import { VOICE } from "../voice";
import { formatMonthDayYear } from "../dates";
import { PLATFORMS } from "./config";
import { getContentRow } from "./repo";
import { Result } from "./rules";

export async function draftCaption(pool: Pool, id: string): Promise<Result<string>> {
  const item = await getContentRow(pool, id);
  if (!item) return { ok: false, error: "Post not found." };
  if (!item.brief && !item.title) return { ok: false, error: "Write a brief first so there's something to draft from." };
  const event = item.eventId
    ? (await pool.query("SELECT name, kind, notes, start_date, end_date FROM events WHERE id = $1", [item.eventId])).rows[0]
    : null;
  const platforms = item.platforms.map((p) => PLATFORMS.find((x) => x.key === p)?.label || p).join(", ");
  const lines = [
    "Draft one GRMC social media post.", "", VOICE, "",
    "--- CONTEXT ---",
    "POST TITLE: " + item.title,
    "BRIEF (purpose, angle, call to action): " + (item.brief || "(none — work from the title)"),
    "PUBLISH DATE: " + (item.publishDate ? formatMonthDayYear(item.publishDate) : "not set"),
    "PLATFORMS: " + (platforms || "Instagram, Facebook"),
  ];
  if (event) {
    lines.push("EVENT/DEPARTMENT: " + event.name + " (" + event.kind + ")");
    if (event.start_date) lines.push("EVENT DATES: " + formatMonthDayYear(event.start_date) + (event.end_date ? " to " + formatMonthDayYear(event.end_date) : ""));
    if (event.notes) lines.push("EVENT NOTES AND KEY MESSAGES: " + event.notes);
  }
  if (item.caption) lines.push("", "CURRENT DRAFT (improve on it, keep what works):", item.caption);
  if (item.platforms.includes("x")) lines.push("", "Keep it under 280 characters so it fits X.");
  const sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with key "post" containing the post text string. No markdown fences, just valid JSON.';
  try {
    const raw = stripJsonFences(await callClaude(pool, sys, lines.join("\n")));
    const post = JSON.parse(raw).post;
    if (typeof post !== "string" || !post.trim()) return { ok: false, error: "Claude came back without a draft. Try again." };
    return { ok: true, value: post.trim() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
