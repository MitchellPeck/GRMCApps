import { createHash } from "node:crypto";
import { ActionItem, ReportBodyInput } from "./claude";

// The minutes are written by Claude from every item's transcript, notes and
// summary, so the write-up is organized across the whole meeting rather than
// stitched together item by item. The parts that must be exact (title,
// attendance, guests, the action item list) are laid out here, in code.

export interface ReportItemInput {
  id: number;
  title: string;
  description: string;
  presenters: string[];
  guestPresenters: string[];
  summary: string;
  notes: string;
  transcript: string;
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

// Library presenters, then guest presenters marked as such.
export function presentedBy(it: Pick<ReportItemInput, "presenters" | "guestPresenters">): string {
  return [...it.presenters, ...it.guestPresenters.map((n) => `${n} (Guest)`)].join(", ");
}

function headerLines(input: ReportInput): string[] {
  const meta = [
    input.meetingDate ? `**Date:** ${input.meetingDate}` : "",
    input.location ? `**Location:** ${input.location}` : "",
  ].filter(Boolean).join(" · ");
  return [`# ${input.title}`, ...(meta ? [meta] : [])];
}

// Guests get their own section at the top, with what each presented.
function guestLines(input: ReportInput): string[] {
  if (!input.guests.length) return [];
  const lines = ["## Guests"];
  for (const g of input.guests) {
    const key = g.name.trim().toLowerCase();
    const items = input.items
      .filter((it) => it.guestPresenters.some((n) => n.trim().toLowerCase() === key))
      .map((it) => it.title);
    lines.push(`- **${g.name}**${g.title ? ` — ${g.title}` : ""}${items.length ? ` · Presented: ${items.join(", ")}` : ""}`);
  }
  return lines;
}

function attendanceLines(input: ReportInput): string[] {
  return [
    "## Attendance",
    `**Present:** ${listOrNone(input.present)}`,
    `**Absent:** ${input.absent.length ? input.absent.join(", ") : "None"}`,
  ];
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

// Fingerprints of what a report is written from. Laid out as the earlier
// code-assembled report was, so reports saved before stay comparable.
export function reportSources(input: ReportInput): ReportSources {
  const attendance = [`**Present:** ${listOrNone(input.present)}`];
  if (input.guests.length) attendance.push(`**Guests:** ${input.guests.map(guestLabel).join(", ")}`);
  attendance.push(`**Absent:** ${input.absent.length ? input.absent.join(", ") : "None"}`);
  const sources: ReportSources = { header: hash(headerLines(input)), attendance: hash(attendance) };
  for (const it of input.items) {
    const by = presentedBy(it);
    const lines = by ? [`**Presented by:** ${by}`] : [];
    if (it.summary.trim()) lines.push(...it.summary.trim().split(/\r?\n/).filter((l) => l.trim()));
    else lines.push(it.hasContent ? "Summary not available." : "No discussion recorded.");
    // Keyed by id with the position left out, so reordering alone does not
    // read as every item having changed.
    sources[`item:${it.id}`] = hash([...lines, it.title, JSON.stringify(it.actionItems)]);
  }
  sources.order = hash(input.items.map((it) => String(it.id)));
  return sources;
}

// What Claude is given to write the body from.
export function reportBodyInput(input: ReportInput): ReportBodyInput {
  return {
    title: input.title,
    meetingDate: input.meetingDate,
    location: input.location,
    present: input.present,
    guests: input.guests.map(guestLabel),
    items: input.items.map((it) => ({
      title: it.title,
      description: it.description,
      presentedBy: presentedBy(it),
      summary: it.summary.trim(),
      actionItems: it.actionItems,
      notes: it.notes.trim(),
      transcript: it.transcript.trim(),
    })),
  };
}

// The full report around Claude's body: header, guests, attendance, then the
// body, then the consolidated action items.
export function buildReport(input: ReportInput, body: string): BuiltReport {
  const actions = consolidateActionItems(input.items);
  const guests = guestLines(input);
  const md: string[] = [
    ...headerLines(input), "",
    ...(guests.length ? [...guests, ""] : []),
    ...attendanceLines(input), "",
    body.trim(), "",
    "## Action Items", ...(actions.length ? actions : ["None recorded."]),
  ];
  return { markdown: md.join("\n") + "\n", sources: reportSources(input) };
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
