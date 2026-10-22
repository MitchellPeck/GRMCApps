import { Pool } from "pg";
import { PlannerPost, PlannerNetwork, textHash } from "../metricool-planner";
import { addLinks, Link } from "./metricool-links";
import { overallStatus } from "./metricool-reconcile";
import { splitContent, getContentRow, ContentRow } from "./repo";

/** A send the app logged without a Metricool id (the create call returned none). */
export interface IdlessSend { textHash: string; networks: string[]; date: string }

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const readable = (n: PlannerNetwork) => !!n.scheduledFor && n.state !== "unknown";

/**
 * Links that just vanished from a still-linked post, and whose network set equals this
 * post's, are what a split left behind: this post is their new home, not a new import.
 * `vanishedMedia` is the media of the post they vanished from, when known.
 */
export function findSplitOrigin(post: PlannerPost, vanished: Link[], vanishedMedia?: string[]): Link[] | null {
  if (!vanished.length || new Set(vanished.map((l) => l.contentItemId)).size !== 1) return null;
  if (!sameSet(post.networks.map((n) => n.network), vanished.map((l) => l.network))) return null;
  const hashes = new Set(post.networks.map((n) => textHash(n.text)));
  const textMatch = vanished.every((l) => l.textHash && hashes.has(l.textHash));
  const mediaMatch = !!vanishedMedia && post.media.length === vanishedMedia.length && post.media.every((m, i) => m === vanishedMedia[i]);
  return textMatch || mediaMatch ? vanished : null;
}

export function shouldImport(
  post: PlannerPost, linkedIds: Set<string>, sentIds: Set<string>, importSince: string, idlessSends: IdlessSend[],
): boolean {
  if (linkedIds.has(post.id) || sentIds.has(post.id)) return false;
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

/**
 * Creates one content item holding every readable network at the earliest time, links each
 * network at its own time, then splits when the times differ. Networks Metricool didn't let
 * us read are left out.
 */
export async function importPlannerPost(db: Pool, post: PlannerPost, _timezone: string): Promise<ContentRow> {
  const nets = post.networks.filter(readable).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  const first = nets[0].scheduledFor;
  const first_line = (nets[0].text.split("\n")[0] || "").trim().slice(0, 80);
  const texts = new Set(nets.map((n) => textHash(n.text)));
  const separate = texts.size > 1;
  const status = overallStatus(nets.map((n) => ({ state: n.state as any, network: n.network, detail: n.detail })), "").status;
  // Straight insert, not createContent: its media and Instagram-image gates are for posts the
  // team builds, and Metricool already holds this one's media.
  const r = await db.query(
    `INSERT INTO content_items (title, platforms, publish_date, publish_time, status, owner_email, caption, no_media_needed,
                                caption_mode, captions, created_by, from_metricool)
     VALUES ($1,$2,$3,$4,$5,'',$6,true,$7,$8,'metricool-import',true) RETURNING id`,
    [first_line || "From Metricool", nets.map((n) => n.network), first.slice(0, 10), first.slice(11, 16) || null, status,
     separate ? "" : nets[0].text, separate ? "separate" : "same",
     separate ? Object.fromEntries(nets.map((n) => [n.network, n.text])) : {}]);
  const id: string = r.rows[0].id;
  for (const n of nets) {
    await addLinks(db, id, post.id, [n.network], n.scheduledFor, n.state === "draft" ? "draft" : "scheduled");
    await db.query(
      `UPDATE metricool_links SET state = $3, detail = $4, public_url = $5, text_hash = $6
        WHERE metricool_post_id = $1 AND network = $2`,
      [post.id, n.network, n.state, n.detail, n.publicUrl, textHash(n.text)]);
  }
  const groups = new Map<string, string[]>();
  for (const n of nets) groups.set(n.scheduledFor, [...(groups.get(n.scheduledFor) || []), n.network]);
  if (groups.size > 1) {
    const s = await splitContent(db, id, [...groups].map(([scheduledFor, networks]) => ({ scheduledFor, networks })));
    if (!s.ok) throw new Error(s.error);
    // Each half's status follows its own networks (the split copied the whole post's).
    await db.query("UPDATE content_items SET from_metricool = true WHERE id = ANY($1)", [[id, ...s.value.created.map((c) => c.id)]]);
    for (const item of [s.value.kept, ...s.value.created]) {
      const mine = nets.filter((n) => item.platforms.includes(n.network));
      const st = overallStatus(mine.map((n) => ({ state: n.state as any, network: n.network, detail: n.detail })), "").status;
      await db.query("UPDATE content_items SET status = $2 WHERE id = $1", [item.id, st]);
    }
    return (await getContentRow(db, s.value.kept.id))!;
  }
  return (await getContentRow(db, id))!;
}
