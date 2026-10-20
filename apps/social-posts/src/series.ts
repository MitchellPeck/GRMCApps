import { Pool } from "pg";
import { HISTORY_SERIES_POSTS, VOICE } from "./voice";
import { callClaude, stripJsonFences } from "./claude";
import { suggestDate } from "./dates";
import { referenceDate } from "./schedule";
import { applySeriesField, syncSeriesMeta, syncSeriesPosts } from "./pipeline/sync";
import { pipelineStatusToSeries } from "./pipeline/rules";

export interface SeriesRow {
  id: string; name: string; description: string; context: string;
  cadence: string; status: string; createdAt: string;
}
export interface SeriesPost {
  seriesId: string; postIdx: number; date: string; phase: string;
  title: string; sub: string; status: string; draft: string; notes: string;
  /** The pipeline's publish date, else the `date` label ("Aug 5") resolved to YYYY-MM-DD. */
  scheduleDate: string;
  /** The content item this post is tracked as in the pipeline, if any. */
  contentItemId: string | null;
}

const FIELD_COLUMNS: Record<string, string> = {
  date: "date", phase: "phase", title: "title", sub: "sub",
  status: "status", draft: "draft", notes: "notes",
};
const META_COLUMNS: Record<string, string> = {
  name: "name", description: "description", context: "context",
  cadence: "cadence", status: "status",
};

export async function seedHistorySeries(pool: Pool): Promise<void> {
  const id = "series-history";
  await pool.query(
    `INSERT INTO series (id, name, description, context, cadence, status)
     VALUES ($1,$2,$3,$4,'weekly','active') ON CONFLICT (id) DO NOTHING`,
    [
      id, "History of GRMC",
      "13-week series on the founding, present, and future of Grace Resurrection",
      "Founded in 2022 in East Cobb/Marietta by Rev. Dr. Randy Mickler, Rev. Charlie Marus, Rev. Dr. Ted Sauter - experienced ministers who came out of retirement. 1200 Indian Hills Pkwy, Marietta GA. Senior Pastor Rev. James Williams joined Oct 2024; Associate Pastor Rev. Taylor Bacon joined Nov 2025.",
    ]
  );
  for (let i = 0; i < HISTORY_SERIES_POSTS.length; i++) {
    const p = HISTORY_SERIES_POSTS[i];
    await pool.query(
      `INSERT INTO series_posts (series_id, post_idx, date, phase, title, sub, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (series_id, post_idx) DO NOTHING`,
      [id, i, p.date, p.phase, p.title, p.sub]
    );
  }
  await syncSeriesPosts(pool, id, await referenceDate(pool), "seed");
}

export async function getAllSeries(pool: Pool): Promise<{ ok: true; series: SeriesRow[] } | { ok: false; error: string }> {
  try {
    let r = await pool.query("SELECT * FROM series");
    if (r.rows.length === 0) { await seedHistorySeries(pool); r = await pool.query("SELECT * FROM series"); }
    const series = r.rows.map((row) => ({
      id: row.id, name: row.name, description: row.description, context: row.context,
      cadence: row.cadence, status: row.status, createdAt: String(row.created_at),
    }));
    return { ok: true, series };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function getSeriesPosts(pool: Pool, seriesId: string): Promise<{ ok: true; posts: SeriesPost[] } | { ok: false; error: string }> {
  try {
    // Once a post is tracked in the content pipeline, its item is the source of
    // truth for status, draft and date; the series_posts columns are a fallback.
    const r = await pool.query(
      `SELECT sp.*, ci.id AS ci_id, ci.status AS ci_status, ci.caption AS ci_caption,
              ci.publish_date::text AS ci_date, ci.title AS ci_title, ci.brief AS ci_brief
         FROM series_posts sp
         LEFT JOIN content_items ci ON ci.series_id = sp.series_id AND ci.post_idx = sp.post_idx
        WHERE sp.series_id = $1 ORDER BY sp.post_idx`,
      [seriesId]
    );
    const ref = await referenceDate(pool);
    const posts = r.rows.map((row) => {
      const tracked = row.ci_id != null;
      return {
        seriesId: row.series_id, postIdx: Number(row.post_idx), date: row.date, phase: row.phase,
        title: tracked ? row.ci_title : row.title, sub: tracked ? row.ci_brief : row.sub,
        status: tracked ? pipelineStatusToSeries(row.ci_status) : row.status,
        draft: tracked ? row.ci_caption : row.draft, notes: row.notes,
        scheduleDate: (tracked && row.ci_date) || suggestDate({ kind: "seriesDate", label: row.date }, ref),
        contentItemId: tracked ? row.ci_id : null,
      };
    });
    return { ok: true, posts };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export interface CreateSeriesParams {
  name: string; description?: string; context?: string; cadence?: string;
  posts?: Array<{ date?: string; phase?: string; title: string; sub?: string }>;
}
export async function createSeries(pool: Pool, params: CreateSeriesParams): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const id = "series-" + Date.now();
    await pool.query(
      `INSERT INTO series (id, name, description, context, cadence, status)
       VALUES ($1,$2,$3,$4,$5,'active')`,
      [id, params.name, params.description || "", params.context || "", params.cadence || "weekly"]
    );
    const posts = params.posts || [];
    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];
      await pool.query(
        `INSERT INTO series_posts (series_id, post_idx, date, phase, title, sub, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [id, i, p.date || "", p.phase || "", p.title, p.sub || ""]
      );
    }
    await syncSeriesPosts(pool, id, await referenceDate(pool), "series");
    return { ok: true, id };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function updateSeriesPostField(pool: Pool, seriesId: string, postIdx: number, field: string, value: string): Promise<{ ok: boolean; error?: string }> {
  const col = FIELD_COLUMNS[field];
  if (!col) return { ok: false, error: "Unknown field: " + field };
  try {
    const r = await pool.query(
      `UPDATE series_posts SET ${col} = $1 WHERE series_id = $2 AND post_idx = $3`,
      [value, seriesId, postIdx]
    );
    if (r.rowCount === 0) return { ok: false, error: "Post not found" };
    await applySeriesField(pool, seriesId, postIdx, field, value, await referenceDate(pool));
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function updateSeriesMeta(pool: Pool, seriesId: string, fields: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  try {
    const sets: string[] = [];
    const vals: string[] = [];
    Object.keys(fields).forEach((f) => {
      const col = META_COLUMNS[f];
      if (col) { vals.push(fields[f]); sets.push(`${col} = $${vals.length}`); }
    });
    if (!sets.length) return { ok: true };
    vals.push(seriesId);
    const r = await pool.query(`UPDATE series SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    if (r.rowCount === 0) return { ok: false, error: "Series not found" };
    await syncSeriesMeta(pool, seriesId, fields);
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function draftSeriesPost(pool: Pool, seriesId: string, postIdx: number): Promise<{ ok: true; post: string; seriesName: string } | { ok: false; error: string }> {
  try {
    const all = await getAllSeries(pool);
    if (!all.ok) throw new Error(all.error);
    const series = all.series.find((s) => s.id === seriesId);
    if (!series) throw new Error("Series not found: " + seriesId);

    const pr = await getSeriesPosts(pool, seriesId);
    if (!pr.ok) throw new Error(pr.error);
    const post = pr.posts.find((p) => p.postIdx === postIdx);
    if (!post) throw new Error("Post not found");

    const lines = [
      `Draft a GRMC social media post for the "${series.name}" series.`, "", VOICE, "",
      "SERIES NAME: " + series.name,
      "SERIES DESCRIPTION: " + series.description,
      "SERIES CONTEXT: " + series.context,
      "", "THIS POST: " + (postIdx + 1) + " of " + pr.posts.length,
      "SCHEDULED DATE: " + (post.date || "TBD"),
      "TITLE: " + post.title,
      "ANGLE: " + (post.sub || ""),
    ];
    if (post.phase) lines.push("PHASE: " + post.phase);
    lines.push("", "Write it as the next chapter in an unfolding story, not a standalone fact post.");
    lines.push("Tone: educational but not lecture-y, warm, inviting, makes people want to follow along.");

    const sys = 'You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. Return ONLY a JSON object with key "post" containing the post text string. No markdown fences, just valid JSON.';
    const raw = stripJsonFences(await callClaude(pool, sys, lines.join("\n")));
    const result = JSON.parse(raw);
    await updateSeriesPostField(pool, seriesId, postIdx, "status", "drafted");
    await updateSeriesPostField(pool, seriesId, postIdx, "draft", result.post);
    return { ok: true, post: result.post, seriesName: series.name };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export interface GeneratePlanParams {
  name: string; description?: string; context?: string;
  count: number; cadence?: string; startDate?: string;
}
export async function generateSeriesPostsWithClaude(pool: Pool, params: GeneratePlanParams): Promise<{ ok: true; posts: any[] } | { ok: false; error: string }> {
  try {
    const lines = [
      `Generate a post schedule for a social media series called "${params.name}".`,
      "Description: " + params.description,
      "Context: " + params.context,
      "Number of posts: " + params.count,
      "Cadence: " + (params.cadence || "weekly"),
      "Start date: " + (params.startDate || "TBD"),
      "",
      "Return ONLY a JSON array of objects, each with: date (string), phase (string, group label or empty), title (short post title), sub (angle/description for this post, 1-2 sentences).",
      "Plan the arc: build toward a conclusion, group into 2-3 phases if it makes sense.",
      "No markdown fences, just valid JSON array.",
    ];
    const sys = "You are a social media content strategist for Grace Resurrection Methodist Church (GRMC) in Marietta, GA.";
    const raw = stripJsonFences(await callClaude(pool, sys, lines.join("\n")));
    return { ok: true, posts: JSON.parse(raw) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
