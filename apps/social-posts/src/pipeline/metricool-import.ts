import { Pool } from "pg";
import { PlannerPost, PlannerNetwork, textHash, wallIn } from "../metricool-planner";
import { addLinks } from "./metricool-links";
import { overallStatus } from "./metricool-reconcile";
import { getContentRow, ContentRow } from "./repo";

/** A send the app logged without a Metricool id (the create call returned none). */
export interface IdlessSend { textHash: string; networks: string[]; date: string }

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const readable = (n: PlannerNetwork) => !!n.scheduledFor && n.state !== "unknown";

export function shouldImport(
  post: PlannerPost, linkedIds: Set<string>, sentIds: Set<string>, importSince: string, idlessSends: IdlessSend[],
  claimedIds: Set<string> = new Set(),  // posts a relink plan already follows
): boolean {
  if (linkedIds.has(post.id) || sentIds.has(post.id) || claimedIds.has(post.id)) return false;
  const nets = post.networks.filter(readable);
  if (!nets.length) return false;
  const date = nets.map((n) => n.scheduledFor).sort()[0].slice(0, 10);
  if (date < importSince) return false;
  // The app's own sends from before ids were recorded: same text, networks and day.
  const mine = post.networks.map((n) => n.network);
  const hashes = new Set(post.networks.map((n) => textHash(n.text)));
  const postDate = post.networks.map((n) => n.scheduledFor).filter(Boolean).sort()[0]?.slice(0, 10);
  return !idlessSends.some((s) => hashes.has(s.textHash) && sameSet(s.networks, mine) && s.date === postDate);
}

/** Sends with no recorded Metricool id, shaped for shouldImport. */
export async function idlessSends(db: Pool): Promise<IdlessSend[]> {
  const rows = (await db.query(
    `SELECT text, networks, left(scheduled_for, 10) AS d FROM metricool_sends WHERE status = 'sent' AND metricool_post_id = ''`)).rows;
  return rows.map((r) => ({
    textHash: textHash(r.text), date: r.d,
    networks: String(r.networks).split(",").map((n) => n.trim()).filter(Boolean).map((n) => (n === "twitter" ? "x" : n)),
  }));
}

/** Id-less content sends shaped for relinkPlan: the item, and the send time on the church's clock. */
export async function idlessSendsForRelink(db: Pool, timezone: string) {
  const rows = (await db.query(
    `SELECT source_ref, text, networks, created_at FROM metricool_sends
      WHERE status = 'sent' AND metricool_post_id = '' AND source_type = 'content' AND source_ref <> ''`)).rows;
  return rows.map((r) => ({
    itemId: String(r.source_ref), textHash: textHash(r.text), sentAt: wallIn(timezone, new Date(r.created_at)),
    networks: String(r.networks).split(",").map((n) => n.trim()).filter(Boolean).map((n) => (n === "twitter" ? "x" : n)),
  }));
}

/**
 * One content item per distinct time (earliest first; the first is returned), each with its
 * networks' links, all in one transaction so a failure leaves nothing for the next sync to
 * trip over. Networks Metricool didn't let us read are left out. The insert skips createContent's
 * gates (they're for posts the team builds), but no_media_needed stays false: the post does have
 * media, and the flag would make later edits of an Instagram post fail the image rule.
 */
// `_timezone` is part of the planned call shape (sync passes the church's zone); times arrive already in it.
export async function importPlannerPost(db: Pool, post: PlannerPost, _timezone: string): Promise<ContentRow> {
  const nets = post.networks.filter(readable).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  const groups = new Map<string, PlannerNetwork[]>();
  for (const n of nets) groups.set(n.scheduledFor, [...(groups.get(n.scheduledFor) || []), n]);
  const client = await db.connect();
  const ids: string[] = [];
  try {
    await client.query("BEGIN");
    for (const [when, group] of groups) {
      const separate = new Set(group.map((n) => textHash(n.text))).size > 1;
      const status = overallStatus(group.map((n) => ({ state: n.state as any, network: n.network, detail: n.detail })), "").status;
      const title = (group[0].text.split("\n")[0] || "").trim().slice(0, 80);
      const r = await client.query(
        `INSERT INTO content_items (title, platforms, publish_date, publish_time, status, owner_email, caption, no_media_needed,
                                    caption_mode, captions, created_by, from_metricool)
         VALUES ($1,$2,$3,$4,$5,'',$6,false,$7,$8,'metricool-import',true) RETURNING id`,
        [title || "From Metricool", group.map((n) => n.network), when.slice(0, 10), when.slice(11, 16) || null, status,
         separate ? "" : group[0].text, separate ? "separate" : "same",
         separate ? Object.fromEntries(group.map((n) => [n.network, n.text])) : {}]);
      const id: string = r.rows[0].id;
      ids.push(id);
      for (const n of group) {
        await addLinks(client as any, id, post.id, [n.network], when, n.state === "draft" ? "draft" : "scheduled", { uuid: post.uuid, created: post.createdAt });
        await client.query(
          `UPDATE metricool_links SET state = $3, detail = $4, public_url = $5, text_hash = $6
            WHERE metricool_post_id = $1 AND network = $2`,
          [post.id, n.network, n.state, n.detail, n.publicUrl, textHash(n.text)]);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return (await getContentRow(db, ids[0]))!;
}
