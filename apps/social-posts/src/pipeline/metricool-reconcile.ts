// Pure: compare a post's Metricool links with what the planner now says.
import { textHash, type LinkState, type PlannerPost } from "../metricool-planner";
import type { Link } from "./metricool-links";
import { PLATFORMS } from "./config";

export interface LinkChange {
  link: Link; scheduledFor?: string; state?: LinkState; detail?: string; publicUrl?: string;
  text?: string; newHash?: string;
}

export function reconcileItem(
  links: Link[], planner: Map<string, PlannerPost>, covered: { from: string; to: string },
): { changes: LinkChange[]; groups: Array<{ scheduledFor: string; networks: string[] }>; unknown: string[] } {
  const changes: LinkChange[] = [];
  const unknown: string[] = [];
  const live: Array<{ scheduledFor: string; network: string }> = [];

  for (const link of links) {
    const net = planner.get(link.metricoolPostId)?.networks.find((n) => n.network === link.network);
    let when = link.scheduledFor;
    let state: LinkState = link.state;

    if (!net) {
      // Absent only means removed if the list covered that day; published posts stay.
      const day = link.scheduledFor.slice(0, 10);
      if (link.state !== "gone" && link.state !== "published" && day >= covered.from && day <= covered.to) {
        changes.push({ link, state: "gone" });
        state = "gone";
      }
    } else if (net.state === "unknown" || net.scheduledFor === "") {
      unknown.push(`${link.network} on ${link.metricoolPostId}: ${net.state === "unknown" ? "status" : "time"} not readable`);
    } else {
      const c: LinkChange = { link };
      if (net.state !== link.state) c.state = net.state;  // also revives a gone link (Metricool undo)
      if (net.scheduledFor !== link.scheduledFor) c.scheduledFor = net.scheduledFor;
      if (net.detail !== link.detail) c.detail = net.detail;
      if (net.publicUrl !== link.publicUrl) c.publicUrl = net.publicUrl;
      const hash = textHash(net.text);
      if (!link.textHash) c.newHash = hash;  // first sync only sets the baseline
      else if (hash !== link.textHash) { c.text = net.text; c.newHash = hash; }
      if (Object.keys(c).length > 1) changes.push(c);
      state = net.state;
      when = net.scheduledFor;
    }
    if (state !== "gone") live.push({ scheduledFor: when, network: link.network });
  }

  const byTime = new Map<string, string[]>();
  for (const l of live) byTime.set(l.scheduledFor, [...(byTime.get(l.scheduledFor) || []), l.network]);
  const groups = [...byTime.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([scheduledFor, networks]) => ({ scheduledFor, networks }));
  return { changes, groups, unknown };
}

/** Plain states, or states with the network and detail so a total failure can be named. */
export type StateInput = LinkState | { state: LinkState; network: string; detail: string };

export function overallStatus(
  states: StateInput[], goneDate: string,
): { status: "published" | "scheduled" | "ready"; note: string } {
  const all = states.map((s) => typeof s === "string" ? { state: s, network: "", detail: "" } : s);
  if (!all.length) return { status: "scheduled", note: "" };  // nothing linked yet, nothing to change
  const kept = all.filter((s) => s.state !== "gone");
  if (!kept.length) return { status: "ready", note: `Removed from Metricool on ${goneDate}.` };
  if (kept.every((s) => s.state === "published")) return { status: "published", note: "" };
  if (kept.every((s) => s.state === "failed")) {
    const label = (n: string) => PLATFORMS.find((p) => p.key === n)?.label || n;
    const parts = kept.map((s) => `${label(s.network)}: ${s.detail}`);
    return { status: "scheduled", note: `Metricool couldn't publish it: ${parts.join("; ")}` };
  }
  return { status: "scheduled", note: "" };
}
