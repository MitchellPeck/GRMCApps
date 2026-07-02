import { Pool } from "pg";
import { getSetting } from "./settings";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

// A single Anthropic content block (text, image, or document). `content` may be
// a plain string (shorthand for one text block) or an array of blocks.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

export function stripJsonFences(raw: string): string {
  return raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

async function callClaude(
  pool: Pool,
  systemPrompt: string,
  content: string | ContentBlock[],
  maxTokens = 1536
): Promise<string> {
  const key = await getSetting(pool, "anthropic_api_key");
  if (!key) throw new Error("No Anthropic API key. Add one in Settings.");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    }),
  });

  const data: any = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.content?.map((b: any) => b.text || "").join("") ?? "";
  return text as string;
}

export interface ExtractedItem {
  title: string;
  description: string;
}

// The set of upload types we can hand to Claude for agenda extraction.
// PDFs go in a document block, images in an image block, everything else is
// decoded as UTF-8 text.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function isSupportedAgendaType(mime: string): boolean {
  return mime === "application/pdf" || mime === "text/plain" || IMAGE_TYPES.includes(mime);
}

const EXTRACT_SYSTEM = `You extract the agenda items from a meeting agenda document.
Return ONLY a JSON array. Each element is an object with:
  "title": a short label for the agenda item (required)
  "description": any sub-points, context, or details for that item ("" if none)
Preserve the order items appear in the document. Do not invent items. Ignore
headers, footers, page numbers, and boilerplate. If the document has no
discernible agenda items, return [].`;

// Ask Claude to turn an uploaded agenda file into an ordered list of items.
export async function extractAgendaItems(
  pool: Pool,
  file: { mimeType: string; buffer: Buffer }
): Promise<ExtractedItem[]> {
  let content: string | ContentBlock[];
  const instruction: ContentBlock = {
    type: "text",
    text: "Extract the agenda items from this document as the JSON array described.",
  };

  if (file.mimeType === "application/pdf") {
    content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.buffer.toString("base64") } },
      instruction,
    ];
  } else if (IMAGE_TYPES.includes(file.mimeType)) {
    content = [
      { type: "image", source: { type: "base64", media_type: file.mimeType, data: file.buffer.toString("base64") } },
      instruction,
    ];
  } else {
    const text = file.buffer.toString("utf8").slice(0, 60000);
    content = `Extract the agenda items from this agenda text as the JSON array described.\n\n---\n${text}`;
  }

  const raw = await callClaude(pool, EXTRACT_SYSTEM, content, 2048);
  return parseItems(raw);
}

export function parseItems(raw: string): ExtractedItem[] {
  let parsed: any;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((el) => ({
      title: String(el?.title ?? "").trim(),
      description: String(el?.description ?? "").trim(),
    }))
    .filter((el) => el.title.length > 0);
}

export interface ActionItem {
  task: string;
  owner: string;
}

export interface SummarizeInput {
  meetingTitle: string;
  itemTitle: string;
  itemDescription: string;
  presenters: string[];
  notes: string;
  transcript: string;
}

export interface SummarizeResult {
  summary: string;
  actionItems: ActionItem[];
}

const SUMMARIZE_SYSTEM = `You are a meeting-minutes assistant. From the transcript
and typed notes for ONE agenda item, produce concise minutes AND extract every
action item.

An "action item" is any commitment, task, follow-up, decision-to-do, or to-do —
INCLUDING ones phrased in natural, conversational language. Treat phrasings like
"we need to X", "we have to X", "someone should X", "let's X", "I'll take care of
X", "I can handle X", "can you follow up on X", "make sure to X", "the next step
is X", "we should look into X", or a deadline like "by next week" as action
items. Do NOT limit yourself to sentences that literally say "action item".

For each action item, identify the owner — the person who committed to it or was
asked to do it. The transcript labels speakers by name ("Alice: ..."); use that
to attribute ownership. Use a real name when it is clear, otherwise "Unassigned".

Respond with ONLY a JSON object, no prose around it:
{
  "summary": "a few sentences and/or short bullet lines covering the discussion and any decisions (plain text, no markdown headings)",
  "actionItems": [ { "task": "clear imperative description", "owner": "Name or Unassigned" } ]
}
Use an empty array when there are genuinely no action items. Base everything
strictly on the provided text; never invent tasks, owners, or decisions.`;

export function parseSummary(raw: string): SummarizeResult {
  let data: any;
  try { data = JSON.parse(stripJsonFences(raw)); } catch { return { summary: raw.trim(), actionItems: [] }; }
  const actionItems: ActionItem[] = Array.isArray(data?.actionItems)
    ? data.actionItems
        .map((a: any) => ({ task: String(a?.task ?? "").trim(), owner: String(a?.owner ?? "").trim() || "Unassigned" }))
        .filter((a: ActionItem) => a.task.length > 0)
    : [];
  return { summary: String(data?.summary ?? "").trim(), actionItems };
}

// Summarize one agenda item and extract its action items.
export async function summarizeItem(pool: Pool, input: SummarizeInput): Promise<SummarizeResult> {
  const presenters = input.presenters.length ? input.presenters.join(", ") : "unspecified";
  const parts = [
    `Meeting: ${input.meetingTitle}`,
    `Agenda item: ${input.itemTitle}`,
    input.itemDescription ? `Item details: ${input.itemDescription}` : "",
    `Presented by: ${presenters}`,
    "",
    input.transcript ? `Transcript (speakers labeled by name where known):\n${input.transcript}` : "Transcript: (none)",
    "",
    input.notes ? `Typed notes:\n${input.notes}` : "Typed notes: (none)",
  ].filter(Boolean);
  if (!input.transcript && !input.notes) {
    throw new Error("Nothing to summarize yet — record a transcript or type notes first.");
  }
  return parseSummary(await callClaude(pool, SUMMARIZE_SYSTEM, parts.join("\n"), 1024));
}

export interface ReportItem {
  title: string;
  presenters: string[];
  summary: string;
  notes: string;
  transcript: string;
  actionItems: ActionItem[];
}

export interface ReportInput {
  title: string;
  meetingDate: string;
  location: string;
  attendees: string[];
  items: ReportItem[];
}

const REPORT_SYSTEM = `You are a meeting-minutes assistant. Produce clean,
professional meeting minutes in Markdown from the structured meeting data
provided. Structure exactly:
  # <Meeting title>
  A line with date, location, and attendees.
  ## Agenda
  For each item: a "### <n>. <title>" heading, who presented it, and a short
  summary of the discussion and any decisions.
  ## Action Items
  A single consolidated checklist (- [ ] style) of EVERY action item across the
  whole meeting. Each line: the task, the owner in **bold** (or **Unassigned**),
  and the agenda item it came from in parentheses.

You are given each item's already-extracted action items — include ALL of them,
none dropped. ALSO re-read each transcript and typed notes and ADD any further
action items you find that were phrased conversationally (e.g. "we need to…",
"someone should…", "I'll handle…", "can you follow up…", "by next week…") and
were not already listed. Merge duplicates. Attribute owners from the named
speakers when possible.

Base everything strictly on the provided material. Never invent attendees,
decisions, or action items. If, after all this, there are truly no action
items, write "None recorded." under the Action Items heading.`;

// Generate a full meeting report from all item summaries + action items.
export async function generateReport(pool: Pool, input: ReportInput): Promise<string> {
  const lines: string[] = [
    `Meeting title: ${input.title}`,
    input.meetingDate ? `Date: ${input.meetingDate}` : "",
    input.location ? `Location: ${input.location}` : "",
    `Attendees: ${input.attendees.length ? input.attendees.join(", ") : "(none recorded)"}`,
    "",
    "Agenda items:",
  ].filter(Boolean);

  input.items.forEach((it, i) => {
    lines.push("");
    lines.push(`${i + 1}. ${it.title}`);
    lines.push(`   Presented by: ${it.presenters.length ? it.presenters.join(", ") : "unspecified"}`);
    if (it.summary) lines.push(`   Summary: ${it.summary}`);
    if (it.actionItems.length) {
      lines.push(`   Action items already extracted for this item:`);
      it.actionItems.forEach((a) => lines.push(`     - ${a.task} (owner: ${a.owner})`));
    }
    if (it.notes) lines.push(`   Typed notes: ${it.notes}`);
    if (it.transcript) lines.push(`   Transcript (speakers labeled by name where known):\n${indent(it.transcript)}`);
    if (!it.summary && !it.notes && !it.transcript) lines.push("   (no notes recorded)");
  });

  return (await callClaude(pool, REPORT_SYSTEM, lines.join("\n"), 3072)).trim();
}

function indent(text: string): string {
  return text.split("\n").map((l) => "     " + l).join("\n");
}
