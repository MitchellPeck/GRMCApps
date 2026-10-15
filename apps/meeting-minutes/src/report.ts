import { createHash } from "node:crypto";
import { ActionItem } from "./claude";

// The minutes are assembled here, in code, from what the per-item summarizer
// already wrote. A second Claude pass over every transcript was slow and, on a
// long meeting, ran past its token limit and failed; this cannot do either.

export interface ReportItemInput {
  id: number;
  title: string;
  presenters: string[];
  summary: string;
  actionItems: ActionItem[];
  hasContent: boolean; // a transcript or typed notes exist
}

export interface ReportGuest {
  name: string;
  title: string;
}

export interface ReportInput {
  title: string;
  meetingDate: string;
  location: string;
  present: string[];
  guests: ReportGuest[];
  absent: string[];
  items: ReportItemInput[];
}

// One fingerprint per part of the report. Saved alongside the report, then
// compared with the current meeting to say what has changed since.
export type ReportSources = Record<string, string>;

export interface BuiltReport {
  markdown: string;
  sources: ReportSources;
}

function guestLabel(g: ReportGuest): string {
  return g.title ? `${g.name} (${g.title})` : g.name;
}

function listOrNone(names: string[]): string {
  return names.length ? names.join(", ") : "None recorded";
}

function attendanceLines(input: ReportInput): string[] {
  const lines = [`**Present:** ${listOrNone(input.present)}`];
  if (input.guests.length) lines.push(`**Guests:** ${input.guests.map(guestLabel).join(", ")}`);
  lines.push(`**Absent:** ${input.absent.length ? input.absent.join(", ") : "None"}`);
  return lines;
}

function itemLines(it: ReportItemInput, n: number): string[] {
  const lines = [`### ${n}. ${it.title}`];
  if (it.presenters.length) lines.push(`**Presented by:** ${it.presenters.join(", ")}`);
  if (it.summary.trim()) lines.push(...it.summary.trim().split(/\r?\n/).filter((l) => l.trim()));
  else lines.push(it.hasContent ? "Summary not available." : "No discussion recorded.");
  return lines;
}

// Every action item across the meeting, tagged with the item it came from.
// The same task for the same owner raised under one item is listed once.
export function consolidateActionItems(items: ReportItemInput[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    for (const a of it.actionItems) {
      const task = a.task.trim();
      if (!task) continue;
      const owner = a.owner.trim() || "Unassigned";
      const key = `${it.id}|${task.toLowerCase()}|${owner.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`- [ ] ${task} — **${owner}** (${it.title})`);
    }
  }
  return out;
}

function hash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

export function buildReport(input: ReportInput): BuiltReport {
  const meta = [
    input.meetingDate ? `**Date:** ${input.meetingDate}` : "",
    input.location ? `**Location:** ${input.location}` : "",
  ].filter(Boolean).join(" · ");
  const header = [`# ${input.title}`, ...(meta ? [meta] : [])];
  const attendance = attendanceLines(input);
  const actions = consolidateActionItems(input.items);

  const md: string[] = [...header, "", ...attendance, "", "## Agenda"];
  const sources: ReportSources = { header: hash(header), attendance: hash(attendance) };
  input.items.forEach((it, i) => {
    const lines = itemLines(it, i + 1);
    md.push("", ...lines);
    // Keyed by id with the position left out, so reordering alone does not
    // read as every item having changed.
    sources[`item:${it.id}`] = hash([...lines.slice(1), it.title, JSON.stringify(it.actionItems)]);
  });
  md.push("", "## Action Items", ...(actions.length ? actions : ["None recorded."]));
  sources.order = hash(input.items.map((it) => String(it.id)));
  return { markdown: md.join("\n") + "\n", sources };
}

// What has changed since a report was generated, in words a person can act
// on. Empty when the report still matches the meeting.
export function reportChanges(
  saved: ReportSources,
  current: ReportSources,
  itemTitles: Map<number, string>
): string[] {
  if (!Object.keys(saved).length) return [];
  const changes: string[] = [];
  if (saved.header !== current.header) changes.push("Meeting details changed");
  if (saved.attendance !== current.attendance) changes.push("Attendance or guests changed");
  const itemKeys = (s: ReportSources) => Object.keys(s).filter((k) => k.startsWith("item:"));
  const savedItems = new Set(itemKeys(saved));
  const currentItems = itemKeys(current);
  const changed: string[] = [];
  const added: string[] = [];
  for (const k of currentItems) {
    const title = itemTitles.get(Number(k.slice(5))) ?? "Untitled item";
    if (!savedItems.has(k)) added.push(title);
    else if (saved[k] !== current[k]) changed.push(title);
  }
  const removed = [...savedItems].filter((k) => !(k in current)).length;
  if (changed.length) changes.push(`Summary changed: ${changed.join(", ")}`);
  if (added.length) changes.push(`Added: ${added.join(", ")}`);
  if (removed) changes.push(`${removed} item${removed === 1 ? "" : "s"} removed`);
  if (!changed.length && !added.length && !removed && saved.order !== current.order) {
    changes.push("Agenda order changed");
  }
  return changes;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineHtml(t: string): string {
  return escapeHtml(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// The report as a standalone HTML document. Google Drive converts this into a
// native Doc on upload, keeping headings, bold, and lists.
export function reportHtml(markdown: string, title: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const ln of markdown.split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(ln);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inlineHtml(h[2])}</h${h[1].length}>`); continue; }
    const b = /^\s*[-*]\s+(?:\[ \]\s+)?(.*)$/.exec(ln);
    if (b) {
      if (!inList) { out.push("<ul>"); inList = true; }
      const box = /^\s*[-*]\s+\[ \]/.test(ln) ? "☐ " : "";
      out.push(`<li>${box}${inlineHtml(b[1])}</li>`);
      continue;
    }
    if (!ln.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inlineHtml(ln)}</p>`);
  }
  closeList();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${out.join("")}</body></html>`;
}
