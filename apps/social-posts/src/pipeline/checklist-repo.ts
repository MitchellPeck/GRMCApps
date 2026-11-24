// Checklist rules in the database, and applying a resolved checklist to an event.
import { Pool, PoolClient } from "pg";
import { addDays } from "../dates";
import { createContent, createEventMedia, createMedia } from "./repo";
import { ChecklistItem, ChecklistRule, fillTitle, parseRuleInput } from "./checklist";
import { graphicType } from "./graphic-types";
import { Result } from "./rules";

type Db = Pool | PoolClient;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function ruleOf(r: Record<string, any>): ChecklistRule {
  return {
    id: r.id, match: r.match, calendarId: r.calendar_id ?? null, namePattern: r.name_pattern, effect: r.effect,
    repeatMode: r.repeat_mode ?? null, items: r.items, position: r.position, active: r.active,
  };
}

export async function listRules(db: Db): Promise<ChecklistRule[]> {
  return (await db.query("SELECT * FROM checklist_rules ORDER BY position, created_at")).rows.map(ruleOf);
}

export async function createRule(db: Db, input: unknown): Promise<Result<ChecklistRule>> {
  const p = parseRuleInput(input, "create");
  if (!p.ok) return p;
  const v = p.value;
  const pos = v.position ?? (await db.query("SELECT COALESCE(max(position), -1) + 1 AS p FROM checklist_rules")).rows[0].p;
  const r = await db.query(
    `INSERT INTO checklist_rules (match, calendar_id, name_pattern, effect, repeat_mode, items, position, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [v.match, v.match === "calendar" ? v.calendarId ?? null : null, v.match === "name" ? v.namePattern ?? "" : "",
     v.effect ?? "add", v.repeatMode ?? null, JSON.stringify(v.items ?? []), pos, v.active ?? true],
  );
  return { ok: true, value: ruleOf(r.rows[0]) };
}

export async function updateRule(db: Db, id: string, input: unknown): Promise<Result<ChecklistRule>> {
  const p = parseRuleInput(input, "patch");
  if (!p.ok) return p;
  const cur = (await db.query("SELECT * FROM checklist_rules WHERE id = $1", [id])).rows[0];
  if (!cur) return fail("Rule not found.");
  const m = { ...ruleOf(cur), ...p.value };
  if (m.match === "calendar" && !m.calendarId) return fail("Pick the calendar this rule is for.");
  if (m.match === "name" && !m.namePattern) return fail("Type the text the event name should contain.");
  const r = await db.query(
    `UPDATE checklist_rules SET match=$2, calendar_id=$3, name_pattern=$4, effect=$5, repeat_mode=$6,
            items=$7, position=$8, active=$9 WHERE id=$1 RETURNING *`,
    [id, m.match, m.match === "calendar" ? m.calendarId : null, m.match === "name" ? m.namePattern : "",
     m.effect, m.repeatMode, JSON.stringify(m.items), m.position, m.active],
  );
  return { ok: true, value: ruleOf(r.rows[0]) };
}

export async function deleteRule(db: Db, id: string): Promise<Result<ChecklistRule>> {
  const r = await db.query("DELETE FROM checklist_rules WHERE id = $1 RETURNING *", [id]);
  return r.rowCount ? { ok: true, value: ruleOf(r.rows[0]) } : fail("Rule not found.");
}

/**
 * Create the checklist's posts and graphics for an event, all or nothing.
 * Posts go first so a graphic's `forPost` index can find its post.
 * `ev.date` is the anchor date the offsets count back from.
 */
export async function applyChecklist(
  db: Db, eventId: string, items: ChecklistItem[],
  ev: { name: string; date: string; ownerEmail: string }, createdBy: string,
): Promise<{ posts: number; graphics: number }> {
  const owned = db instanceof Pool ? await db.connect() : null;
  const c: Db = owned ?? db;
  const tx = !!owned; // an already-open client belongs to the caller's transaction
  let posts = 0, graphics = 0;
  try {
    if (tx) await c.query("BEGIN");
    const postIds = new Map<number, string>();
    for (const [i, it] of items.entries()) {
      if (it.kind !== "post") continue;
      const r = await createContent(c, {
        title: fillTitle(it.title, ev), eventId, platforms: it.platforms, status: "planned",
        publishDate: addDays(ev.date, -it.daysBefore), ownerEmail: ev.ownerEmail,
      }, createdBy);
      if (!r.ok) throw new Error(r.error);
      await c.query("UPDATE content_items SET rule_days_before = $2 WHERE id = $1", [r.value.id, it.daysBefore]);
      postIds.set(i, r.value.id);
      posts++;
    }
    for (const it of items) {
      if (it.kind !== "graphic") continue;
      const input = {
        description: graphicType(it.graphicType)?.label ?? it.graphicType, type: "graphic",
        graphicType: it.graphicType, gatherDate: addDays(ev.date, -it.daysBefore),
      };
      const postId = it.forPost !== undefined ? postIds.get(it.forPost) : undefined;
      const r = postId ? await createMedia(c, postId, input) : await createEventMedia(c, eventId, input);
      if (!r.ok) throw new Error(r.error);
      await c.query("UPDATE media_assets SET rule_days_before = $2 WHERE id = $1", [r.value.media.id, it.daysBefore]);
      graphics++;
    }
    if (tx) await c.query("COMMIT");
  } catch (e) {
    if (tx) await c.query("ROLLBACK");
    throw e;
  } finally {
    if (owned) (owned as PoolClient).release();
  }
  return { posts, graphics };
}
