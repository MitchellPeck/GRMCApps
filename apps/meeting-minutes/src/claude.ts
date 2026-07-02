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

export interface SummarizeInput {
  meetingTitle: string;
  itemTitle: string;
  itemDescription: string;
  presenters: string[];
  notes: string;
  transcript: string;
}

const SUMMARIZE_SYSTEM = `You are a meeting minutes assistant. Given the raw
transcript and typed notes for a single agenda item, write concise minutes for
that item. Use plain prose and short bullet points. Capture key discussion
points, decisions made, and any action items (with owners if named). Do not
add information that is not present. Keep it tight — a few sentences to a short
list. Output plain text (no markdown headers).`;

// Summarize one agenda item from its transcript + notes.
export async function summarizeItem(pool: Pool, input: SummarizeInput): Promise<string> {
  const presenters = input.presenters.length ? input.presenters.join(", ") : "unspecified";
  const parts = [
    `Meeting: ${input.meetingTitle}`,
    `Agenda item: ${input.itemTitle}`,
    input.itemDescription ? `Item details: ${input.itemDescription}` : "",
    `Presented by: ${presenters}`,
    "",
    input.transcript ? `Transcript:\n${input.transcript}` : "Transcript: (none)",
    "",
    input.notes ? `Typed notes:\n${input.notes}` : "Typed notes: (none)",
  ].filter(Boolean);
  if (!input.transcript && !input.notes) {
    throw new Error("Nothing to summarize yet — record a transcript or type notes first.");
  }
  return (await callClaude(pool, SUMMARIZE_SYSTEM, parts.join("\n"), 1024)).trim();
}

export interface ReportItem {
  title: string;
  presenters: string[];
  summary: string;
  notes: string;
  transcript: string;
}

export interface ReportInput {
  title: string;
  meetingDate: string;
  location: string;
  attendees: string[];
  items: ReportItem[];
}

const REPORT_SYSTEM = `You are a meeting minutes assistant. Produce clean,
professional meeting minutes in Markdown from the structured meeting data
provided. Structure:
  # <Meeting title>
  A line with date, location, and attendees.
  ## Agenda
  For each item: a "### <n>. <title>" heading, who presented it, a short
  summary of the discussion, decisions, and any action items.
  ## Action Items
  A consolidated checklist of every action item across the meeting, each with
  an owner if one was named.
Base everything strictly on the provided summaries, notes, and transcripts. Do
not invent attendees, decisions, or action items. If there are no action items,
say "None recorded."`;

// Generate a full meeting report from all item summaries.
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
    else if (it.notes || it.transcript) {
      if (it.notes) lines.push(`   Notes: ${it.notes}`);
      if (it.transcript) lines.push(`   Transcript: ${it.transcript}`);
    } else {
      lines.push("   (no notes recorded)");
    }
  });

  return (await callClaude(pool, REPORT_SYSTEM, lines.join("\n"), 3072)).trim();
}
