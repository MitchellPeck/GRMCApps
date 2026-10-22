// Sending a post to Metricool: one Metricool post per distinct (text, time), each logged, then
// the pipeline post is split by time, linked to what was sent, and synced. The bookkeeping after a
// send is logged and never turns a successful send into an error.
import { Pool } from "pg";
import { buildSchedulerPayload, charWarnings, isPublishMode, MetricoolCreds, PublishMode, schedulePost } from "../metricool";
import { logSend } from "../metricool-sends";
import { addLinks, hasLiveLinks, pendingIdlessSends } from "./metricool-links";
import { syncMetricool } from "./metricool-sync";
import { splitContent } from "./repo";
import { markSentToMetricool } from "./sync";

export const ALREADY_SENT = "Already in Metricool. Change it there; it syncs back.";

export interface SendRequest {
  text: string;
  /** A different text per network; each distinct text goes as its own Metricool post. */
  texts?: Record<string, string>;
  networks: string[]; dateTime: string; timezone: string;
  /** network → YYYY-MM-DDTHH:MM:SS, when platforms go at different times. */
  networkTimes?: Record<string, string>;
  publish: PublishMode;
  /** The pipeline post this came from. */
  contentItemId?: string;
  sourceType: string; sourceRef: string; imageRef: string; createdBy: string;
}

export interface SendDeps {
  creds: () => Promise<MetricoolCreds>;
  /** Puts the ticked media somewhere public; called only once the send is allowed. */
  media: (creds: MetricoolCreds) => Promise<string[]>;
  warn?: (e: unknown) => void;
}

export type SendResult =
  | { ok: true; metricoolPostId: string; scheduledFor: string; warnings: string[]; note: string; autoPublish: boolean; sentTo?: string[] }
  | { ok: false; error: string };

interface Group { text: string; networks: string[]; dateTime: string }
interface Sent extends Group { postId: string; logId: string }

const LABELS: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", twitter: "X" };
const names = (networks: string[]) => networks.map((n) => LABELS[n] || n).join(" and ");
// Metricool still calls X "twitter"; posts and links call it "x".
const platformOf = (n: string) => (n === "twitter" ? "x" : n);
// Metricool wants seconds; a time picker gives none.
const withSeconds = (t: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? t + ":00" : t);

/** One group per distinct (text, time), earliest first. */
export function groupSends(r: Pick<SendRequest, "text" | "texts" | "networks" | "dateTime" | "networkTimes">): Group[] {
  const groups: Group[] = [];
  for (const n of r.networks) {
    const text = r.texts?.[n] ?? r.text ?? "";
    if (!text.trim()) continue;
    const dateTime = withSeconds(r.networkTimes?.[n] || r.dateTime || "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dateTime)) throw new Error(`Pick a date and time for ${names([n])}.`);
    const g = groups.find((x) => x.text === text && x.dateTime === dateTime);
    if (g) g.networks.push(n); else groups.push({ text, networks: [n], dateTime });
  }
  return groups.sort((a, b) => a.dateTime.localeCompare(b.dateTime));
}

/**
 * True when the post is in Metricool already: a live link, or (with none) a send Metricool gave no
 * id that a sync hasn't matched yet (made after the post's links last went, within the last day).
 * All gone means it can go again.
 */
export async function alreadyInMetricool(db: Pool, itemId: string): Promise<boolean> {
  return await hasLiveLinks(db, itemId) || (await pendingIdlessSends(db, itemId)).length > 0;
}

export async function sendToMetricool(pool: Pool, r: SendRequest, deps: SendDeps): Promise<SendResult> {
  const warn = deps.warn || (() => {});
  const networks = Array.isArray(r.networks) ? r.networks : [];
  let mediaUrls: string[] = [];
  const log = (g: Group, postId: string, error = "") => logSend(pool, {
    sourceType: r.sourceType || "", sourceRef: r.sourceRef || "", text: g.text, networks: g.networks.join(","),
    imageRef: r.imageRef || "", r2Url: mediaUrls.join(" "), scheduledFor: g.dateTime, timezone: r.timezone || "",
    metricoolPostId: postId, status: error ? "error" : "sent", error, createdBy: r.createdBy || "",
  });

  let groups: Group[];
  let creds: MetricoolCreds;
  try {
    if (!isPublishMode(r.publish)) throw new Error("Say whether to schedule it or send it as a draft.");
    groups = groupSends({ ...r, networks });
    if (!groups.length) throw new Error("Pick at least one network, with text to send.");
    if (r.contentItemId && await alreadyInMetricool(pool, r.contentItemId)) throw new Error(ALREADY_SENT);
    creds = await deps.creds();
    mediaUrls = await deps.media(creds);
  } catch (e) {
    const error = (e as Error).message;
    await log({ text: r.text || "", networks, dateTime: r.dateTime || "" }, "", error).catch(() => {});
    return { ok: false, error };
  }

  const sent: Sent[] = [];
  let failure = "";
  for (const g of groups) {
    const payload = buildSchedulerPayload({ text: g.text, networks: g.networks, dateTime: g.dateTime, timezone: r.timezone, mediaUrls, publish: r.publish });
    let postId: string;
    try { postId = await schedulePost(creds, payload); } catch (e) {
      failure = `${sent.length ? `Sent ${sent.map((s) => names(s.networks)).join(", ")}, but ` : ""}${names(g.networks)} failed: ${(e as Error).message}`;
      await log(g, "", (e as Error).message).catch(() => {});
      break;
    }
    // It's in Metricool now; a lost log row mustn't hide that.
    const logId = await log(g, postId).catch((e) => { warn(e); return ""; });
    sent.push({ ...g, postId, logId });
  }

  const unsent = groups.slice(sent.length);
  if (sent.length && r.contentItemId) await afterSend(pool, r, sent, unsent, warn);
  if (failure) return { ok: false, error: failure };

  const times = new Set(sent.map((s) => s.dateTime));
  // A scheduled Instagram post publishes itself, so a missing image isn't
  // something a human gets a chance to fix — Instagram rejects it outright.
  const note = r.publish === "scheduled" && networks.includes("instagram") && !mediaUrls.length
    ? "Instagram won't publish without an image — add one in Metricool before the scheduled time." : "";
  return {
    ok: true, metricoolPostId: sent[0].postId, scheduledFor: sent[0].dateTime,
    warnings: groups.flatMap((g) => charWarnings(g.text, g.networks)), note, autoPublish: r.publish === "scheduled",
    sentTo: sent.length > 1 ? sent.map((s) => names(s.networks) + (times.size > 1 ? ` (${s.dateTime.slice(0, 16).replace("T", " ")})` : "")) : undefined,
  };
}

/**
 * Split by time, mark each part Scheduled at its time, link what was sent, then sync each part.
 * Networks that didn't go (a later group failed) move to a post of their own with no links, so
 * they can still be sent; the post holding what went keeps its links.
 */
async function afterSend(pool: Pool, r: SendRequest, sent: Sent[], unsent: Group[], warn: (e: unknown) => void): Promise<void> {
  const itemId = r.contentItemId!;
  const times = [...new Set(sent.map((s) => s.dateTime))].sort();
  const holder = new Map(times.map((t) => [t, itemId]));  // time → the post that holds it
  const nets = (gs: Group[]) => [...new Set(gs.flatMap((g) => g.networks.map(platformOf)))];
  const unsentTimes = [...new Set(unsent.map((g) => g.dateTime))].sort();
  const parts = [
    ...times.map((t) => ({ scheduledFor: t, networks: nets(sent.filter((s) => s.dateTime === t)) })),
    ...unsentTimes.map((t) => ({ scheduledFor: t, networks: nets(unsent.filter((g) => g.dateTime === t)) })),
  ];
  if (parts.length > 1) {
    try {
      const item = (await pool.query(`SELECT platforms FROM content_items WHERE id = $1`, [itemId])).rows[0];
      // Platforms not in this send stay on the original post rather than being dropped.
      const named = new Set(parts.flatMap((g) => g.networks));
      parts[0].networks.push(...((item?.platforms || []) as string[]).filter((p) => !named.has(p)));
      const split = await splitContent(pool, itemId, parts);
      // Created posts come back in parts order; only the sent times need their holder.
      if (split.ok) split.value.created.slice(0, times.length - 1).forEach((c, i) => holder.set(times[i + 1], c.id));
      else warn(new Error(split.error));
    } catch (e) { warn(e); }
  }
  for (const t of times) await markSentToMetricool(pool, holder.get(t)!, t).catch(warn);
  for (const s of sent) {
    const owner = holder.get(s.dateTime)!;
    // The send log follows the post too, so an id-less send is relinked (and refused) on the right one.
    if (owner !== itemId && s.logId && r.sourceRef === itemId) {
      await pool.query(`UPDATE metricool_sends SET source_ref = $2 WHERE id = $1`, [s.logId, owner]).catch(warn);
    }
    // No id means no link: the sync below finds it in the planner instead.
    if (s.postId) {
      await addLinks(pool, owner, s.postId, s.networks.map(platformOf), s.dateTime, r.publish === "draft" ? "draft" : "scheduled").catch(warn);
    }
  }
  for (const owner of new Set(holder.values())) await syncMetricool(pool, { itemId: owner }).catch(warn);
}
