import { Pool } from "pg";
import { PlannerPost, textHash } from "../metricool-planner";
import type { Link } from "./metricool-links";

/** An id-less send from the log; `sendId` is its metricool_sends row, which gets the post id once relinked. */
export interface RelinkSend { sendId: string; itemId: string; networks: string[]; textHash: string; sentAt: string }
export interface RelinkEntry {
  link: Link | null; itemId: string; network: string; toPostId: string; uuid: string; created: string; scheduledFor: string;
  /** The id-less send this entry came from (link: null only). */
  sendId?: string;
}
export interface RelinkResult {
  entries: RelinkEntry[];
  /** Planner posts some link or send could have become but no one surely did: never imported this run. */
  contested: Set<string>;
  /** Links whose post vanished and which matched something, but not surely: never marked gone this run. */
  unsure: Link[];
}

const key = (postId: string, network: string) => `${postId}|${network}`;
// Both are church-zone YYYY-MM-DDTHH:MM; compared as wall clocks, which is fine for a one-minute window.
const minuteApart = (a: string, b: string) => {
  const x = Date.parse(a + ":00Z"), y = Date.parse(b + ":00Z");
  return !isNaN(x) && !isNaN(y) && Math.abs(x - y) <= 60_000;
};

/**
 * Metricool gives a post a new id when one of its networks is moved or edited. Pure: for links whose
 * post vanished, and app sends that never got an id, find the one planner post+network each became.
 * `held` is every post id in metricool_links (not just `links`), so another item's post is never taken.
 * Ambiguity changes nothing. A planner post+network is never handed to two entries: an existing link
 * beats an id-less send (that send is usually the one the link was made from); two links, or two
 * sends, wanting it cancel each other. Whatever was ambiguous is reported, so the caller neither
 * imports its candidates nor marks its links gone.
 */
export function relinkPlan(links: Link[], planner: PlannerPost[], idless: RelinkSend[], held: Set<string>): RelinkResult {
  const present = new Set(planner.map((p) => p.id));
  const free = planner.filter((p) => !held.has(p.id));
  const picks: RelinkEntry[] = [];
  const contested = new Set<string>();
  const unsure: Link[] = [];

  for (const link of links) {
    if (present.has(link.metricoolPostId)) continue;
    const cands = free.filter((p) => p.networks.some((n) => n.network === link.network));
    const textOf = (p: PlannerPost) => textHash(p.networks.find((n) => n.network === link.network)!.text);
    let found = link.metricoolUuid ? cands.filter((p) => p.uuid === link.metricoolUuid) : [];
    if (!found.length) {
      // No creator check: Link stores no creator id, so createdAt plus text (or created alone) decides.
      found = cands.filter((p) => p.createdAt && p.createdAt === link.metricoolCreated
        && (link.textHash ? textOf(p) === link.textHash : true));
    }
    if (found.length > 1) {
      found.forEach((p) => contested.add(p.id));
      unsure.push(link);
    }
    if (found.length !== 1) continue;
    const p = found[0];
    picks.push({ link, itemId: link.contentItemId, network: link.network, toPostId: p.id, uuid: p.uuid, created: p.createdAt,
      scheduledFor: p.networks.find((n) => n.network === link.network)!.scheduledFor });
  }

  for (const s of idless) {
    for (const network of s.networks) {
      const found = free.filter((p) => minuteApart(p.createdAt, s.sentAt)
        && p.networks.some((n) => n.network === network && textHash(n.text) === s.textHash));
      if (found.length > 1) found.forEach((p) => contested.add(p.id));
      if (found.length !== 1) continue;
      const p = found[0];
      picks.push({ link: null, itemId: s.itemId, network, toPostId: p.id, uuid: p.uuid, created: p.createdAt,
        scheduledFor: p.networks.find((n) => n.network === network)!.scheduledFor, sendId: s.sendId });
    }
  }

  const byTarget = new Map<string, RelinkEntry[]>();
  for (const e of picks) byTarget.set(key(e.toPostId, e.network), [...(byTarget.get(key(e.toPostId, e.network)) || []), e]);
  const entries: RelinkEntry[] = [];
  for (const want of byTarget.values()) {
    const fromLinks = want.filter((e) => e.link);
    const contenders = fromLinks.length ? fromLinks : want;
    if (contenders.length === 1) { entries.push(contenders[0]); continue; }
    // Two links (or two sends) wanting the same post+network means none is sure.
    contested.add(contenders[0].toPostId);
    for (const e of contenders) if (e.link) unsure.push(e.link);
  }
  return { entries, contested, unsure };
}

/** Every post id any link holds, so relinkPlan never takes another item's post. */
export async function heldPostIds(db: Pool): Promise<Set<string>> {
  return new Set((await db.query(`SELECT DISTINCT metricool_post_id FROM metricool_links`)).rows.map((r) => String(r.metricool_post_id)));
}

/** Record uuid/created for links whose post is still in the planner, so a later move or edit can be followed. */
export async function refreshIdents(db: Pool, links: Link[], planner: PlannerPost[]): Promise<number> {
  const byId = new Map(planner.map((p) => [p.id, p]));
  let n = 0;
  for (const l of links) {
    const p = byId.get(l.metricoolPostId);
    if (!p) continue;
    // An unreadable (empty) value never wipes one we already hold: it's what a later relink matches on.
    const uuid = p.uuid || l.metricoolUuid, created = p.createdAt || l.metricoolCreated;
    if (uuid === l.metricoolUuid && created === l.metricoolCreated) continue;
    n += (await db.query(
      `UPDATE metricool_links SET metricool_uuid = $3, metricool_created = $4 WHERE metricool_post_id = $1 AND network = $2`,
      [l.metricoolPostId, l.network, uuid, created])).rowCount || 0;
  }
  return n;
}

/**
 * Rewrite each link to its new id (state stays); an id-less send gets a new scheduled link, and its
 * log row gets the post id, so it's no longer id-less (later relinks and the import guard see the
 * id). Never overwrites a row that already holds the target (post id, network), and never links a
 * post that has since been deleted here: those entries are skipped. Returns the rows actually written.
 */
export async function applyRelink(db: Pool, plan: RelinkEntry[]): Promise<number> {
  const client = await db.connect();
  let written = 0;
  try {
    await client.query("BEGIN");
    for (const e of plan) {
      if (e.link) {
        written += (await client.query(
          `UPDATE metricool_links SET metricool_post_id = $3, metricool_uuid = $4, metricool_created = $5, last_seen_at = now()
            WHERE metricool_post_id = $1 AND network = $2
              AND NOT EXISTS (SELECT 1 FROM metricool_links WHERE metricool_post_id = $3 AND network = $2)`,
          [e.link.metricoolPostId, e.network, e.toPostId, e.uuid, e.created])).rowCount || 0;
      } else {
        const n = (await client.query(
          `INSERT INTO metricool_links (content_item_id, metricool_post_id, network, scheduled_for, state, last_seen_at, metricool_uuid, metricool_created)
           SELECT $1,$2,$3,$4,'scheduled', now(), $5, $6 WHERE EXISTS (SELECT 1 FROM content_items WHERE id = $1)
           ON CONFLICT (metricool_post_id, network) DO NOTHING`,
          [e.itemId, e.toPostId, e.network, e.scheduledFor.slice(0, 16), e.uuid, e.created])).rowCount || 0;
        if (n && e.sendId) {
          await client.query(`UPDATE metricool_sends SET metricool_post_id = $2 WHERE id = $1 AND metricool_post_id = ''`, [e.sendId, e.toPostId]);
        }
        written += n;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return written;
}
