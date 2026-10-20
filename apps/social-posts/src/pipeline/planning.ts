// Turning one thing into several posts: an episode into one post per angle
// (what the Podcast run did), and a series into a plan Claude proposes and a
// person edits (what the Series tab's "Generate post plan" did).
import { Pool } from "pg";
import { addDays } from "../dates";
import { getEpisode } from "../buzzsprout";
import { callClaude, stripJsonFences } from "../claude";
import { DEFAULT_PLATFORMS } from "./config";
import { SERIES_PLAN_PROMPT } from "./drafting-seed";
import { ContentRow, createContent } from "./repo";
import { Result, isIsoDate } from "./rules";

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export async function planFromEpisode(
  pool: Pool, eventId: string, episodeId: string, angleKeys: string[], createdBy: string, today: string,
): Promise<Result<ContentRow[]>> {
  const ev = (await pool.query("SELECT drafting FROM events WHERE id = $1", [eventId])).rows[0];
  if (!ev) return fail("Event not found.");
  if (ev.drafting?.source?.kind !== "buzzsprout") return fail("This event's source isn't Buzzsprout, so there are no episodes to plan from.");
  const angles = (ev.drafting.angles || []).filter((a: { key: string }) => angleKeys.includes(a.key));
  if (!angles.length) return fail("Pick at least one angle.");
  const ep = await getEpisode(pool, episodeId);
  const base = ep.publishDate || today;
  const items: ContentRow[] = [];
  for (const a of angles) {
    const r = await createContent(pool, {
      title: `${a.label}: ${ep.title}`, eventId, publishDate: addDays(base, a.offsetDays), platforms: DEFAULT_PLATFORMS,
      drafting: { instructions: a.instructions },
      sourceRef: { kind: "buzzsprout", id: String(ep.id), title: ep.title, url: ep.listenUrl, date: ep.publishDate },
    }, createdBy);
    if (!r.ok) return r;
    items.push(r.value);
  }
  return { ok: true, value: items };
}

export interface PlannedPost { date: string; phase: string; title: string; sub: string }

export async function proposeSeriesPlan(
  pool: Pool, eventId: string, params: { count: number; cadence: string; startDate: string },
): Promise<Result<PlannedPost[]>> {
  const ev = (await pool.query("SELECT name, notes FROM events WHERE id = $1", [eventId])).rows[0];
  if (!ev) return fail("Event not found.");
  if (!Number.isInteger(params.count) || params.count < 1 || params.count > 52) return fail("Plan between 1 and 52 posts.");
  const sys = "You are a social media content strategist for Grace Resurrection Methodist Church (GRMC) in Marietta, GA.";
  const lines = SERIES_PLAN_PROMPT({ name: ev.name, description: "", context: ev.notes || "", count: params.count,
    cadence: params.cadence || "weekly", startDate: params.startDate || "" });
  let rows: unknown;
  try { rows = JSON.parse(stripJsonFences(await callClaude(pool, sys, lines.join("\n")))); }
  catch (e) { return fail(e instanceof SyntaxError ? "Claude's plan wasn't readable. Try again." : (e as Error).message); }
  if (!Array.isArray(rows)) return fail("Claude's plan wasn't a list. Try again.");
  const posts = rows.map((r: any) => ({
    date: isIsoDate(r?.date) ? r.date : "", phase: String(r?.phase ?? ""), title: String(r?.title ?? "").trim(), sub: String(r?.sub ?? ""),
  })).filter((p) => p.title);
  return posts.length ? { ok: true, value: posts } : fail("Claude's plan had no posts. Try again.");
}

export async function saveSeriesPlan(pool: Pool, eventId: string, posts: PlannedPost[], createdBy: string): Promise<Result<ContentRow[]>> {
  const bad = posts.findIndex((p) => !String(p.title || "").trim() || !isIsoDate(p.date));
  if (bad !== -1) return fail(`Post ${bad + 1} needs a title and a date.`);
  const items: ContentRow[] = [];
  for (const p of posts) {
    const r = await createContent(pool, { title: p.title.trim(), publishDate: p.date, brief: p.sub || "", phase: p.phase || "", eventId }, createdBy);
    if (!r.ok) return r;
    items.push(r.value);
  }
  return { ok: true, value: items };
}
