import { Pool } from "pg";
import { PlannerPost, textHash } from "../metricool-planner";
import { Link, addLinks } from "./metricool-links";

export interface RelinkSend { itemId: string; networks: string[]; textHash: string; sentAt: string }
export interface RelinkEntry {
  link: Link | null; itemId: string; network: string; toPostId: string; uuid: string; created: string; scheduledFor: string;
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
 * Ambiguity changes nothing, and a planner post+network is never handed to two entries.
 */
export function relinkPlan(links: Link[], planner: PlannerPost[], idless: RelinkSend[]): RelinkEntry[] {
  const present = new Set(planner.map((p) => p.id));
  const held = new Set(links.map((l) => l.metricoolPostId));
  const free = planner.filter((p) => !held.has(p.id));
  const picks: RelinkEntry[] = [];

  for (const link of links) {
    if (present.has(link.metricoolPostId)) continue;
    const cands = free.filter((p) => p.networks.some((n) => n.network === link.network));
    const textOf = (p: PlannerPost) => textHash(p.networks.find((n) => n.network === link.network)!.text);
    let found = link.metricoolUuid ? cands.filter((p) => p.uuid === link.metricoolUuid) : [];
    if (!found.length) {
      found = cands.filter((p) => p.createdAt && p.createdAt === link.metricoolCreated && p.creatorId
        && (link.textHash ? textOf(p) === link.textHash : true));
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
      if (found.length !== 1) continue;
      const p = found[0];
      picks.push({ link: null, itemId: s.itemId, network, toPostId: p.id, uuid: p.uuid, created: p.createdAt,
        scheduledFor: p.networks.find((n) => n.network === network)!.scheduledFor });
    }
  }

  // Two entries wanting the same post+network means neither is sure.
  const wanted = new Map<string, number>();
  for (const e of picks) wanted.set(key(e.toPostId, e.network), (wanted.get(key(e.toPostId, e.network)) || 0) + 1);
  return picks.filter((e) => wanted.get(key(e.toPostId, e.network)) === 1);
}

/** Rewrite each link to its new id (state stays); an id-less send gets a new scheduled link. */
export async function applyRelink(db: Pool, plan: RelinkEntry[]): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const e of plan) {
      if (e.link) {
        await client.query(
          `UPDATE metricool_links SET metricool_post_id = $3, metricool_uuid = $4, metricool_created = $5, last_seen_at = now()
            WHERE metricool_post_id = $1 AND network = $2`,
          [e.link.metricoolPostId, e.network, e.toPostId, e.uuid, e.created]);
      } else {
        await addLinks(client as any, e.itemId, e.toPostId, [e.network], e.scheduledFor, "scheduled", { uuid: e.uuid, created: e.created });
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return plan.length;
}
