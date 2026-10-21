import { Pool } from "pg";
import { getSetting } from "./settings";
import { SpeakerMap } from "./transcript";
import { parseClockRange } from "./ranges";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
// Generous for a summary of a long topic, short enough that a wedged request
// cannot hold a serial queue for the rest of the day.
const CLAUDE_TIMEOUT_MS = 4 * 60 * 1000;
// The report writes up a whole meeting in one reply, which takes longer.
const REPORT_TIMEOUT_MS = 10 * 60 * 1000;

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
  maxTokens = 1536,
  timeoutMs = CLAUDE_TIMEOUT_MS
): Promise<string> {
  const key = await getSetting(pool, "anthropic_api_key");
  if (!key) throw new Error("No Anthropic API key. Add one in Settings.");

  // Every Claude call runs on a serial queue (transcription or AI work), so
  // one request that never returns would stall every later job. Bound it.
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") {
      throw new Error(`Claude did not respond within ${timeoutMs / 1000}s.`);
    }
    throw new Error(`Could not reach Claude: ${(e as Error).message}`);
  }

  const data: any = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.content?.map((b: any) => b.text || "").join("") ?? "";
  // A reply cut off at max_tokens is incomplete JSON for every structured
  // caller; saving it produced a "summary" that was literally half a JSON
  // object. Fail loudly instead so the caller can retry or report it.
  if (data.stop_reason === "max_tokens") {
    throw new Error("Claude's reply was cut off before it finished.");
  }
  return text as string;
}

export interface ExtractedItem {
  title: string;
  description: string;
  presenter: string; // as written in the document; "" when none is named
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
  "presenter": the name of the person presenting, leading, or reporting on this
    item, written exactly as it appears in the document ("" if none is named)
Put a presenter's name in "presenter" ONLY. Strip phrasing like "Presented by
Jane Doe", "— Jane Doe", "(Jane Doe)", or "Report from Jane Doe" out of both
"title" and "description"; do not leave the name duplicated there.
Preserve the order items appear in the document. Do not invent items or
presenters. Ignore headers, footers, page numbers, and boilerplate. If the
document has no discernible agenda items, return [].`;

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
      presenter: String(el?.presenter ?? "").trim(),
    }))
    .filter((el) => el.title.length > 0);
}

export interface ActionItem {
  task: string;
  owner: string;
  // Where it was agreed, in seconds on the topic's recording; both or neither.
  start?: number;
  end?: number;
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

export const SUMMARIZE_SYSTEM = `You are a meeting-minutes assistant. From the transcript
and typed notes for ONE agenda item, produce concise minutes and list its
action items.

An "action item" is a specific task that a named person agreed to do, or was
asked to do (or that was assigned to a named group, such as "the trustees").
Natural phrasing counts: "I'll take care of X", "can you follow up on X",
"Bob will get quotes by next week". These are NOT action items: suggestions,
ideas, "we should look into X", "let's think about X", "it would be good to X",
or general aims that nobody took on. List each task once, merging restatements
of the same task.

For each action item, give the owner: the person who agreed to it or was asked
to do it. The transcript labels speakers by name ("Alice: ..."); use that to
attribute ownership. Use a real name when it is clear, otherwise "Unassigned".
Give "at", the stretch of the recording where it was agreed, as "start-end",
copying the [mm:ss] stamps at the start of transcript turns exactly as written
(past the first hour they read h:mm:ss, e.g. 1:10:03); use "" when the
transcript has no stamps.

Respond with ONLY a JSON object, no prose around it:
{
  "summary": "a few sentences and/or short bullet lines covering what was reported and decided (plain text, no markdown headings)",
  "actionItems": [ { "task": "clear imperative description", "owner": "Name or Unassigned", "at": "mm:ss-mm:ss" } ]
}
Use an empty array when there are no action items. Base everything strictly on
the provided text; never invent tasks, owners, or decisions.`;

// The "at" range of an action item; nothing when it doesn't read.
function actionTimes(at: unknown): { start: number; end: number } | {} {
  return parseClockRange(String(at ?? "")) ?? {};
}

// Best-effort recovery from a JSON reply that does not parse (e.g. cut off
// mid-array): the summary string, and every action item that is complete.
function salvageSummary(raw: string): SummarizeResult | null {
  const m = /"summary"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw);
  if (!m) return null;
  let summary: string;
  try { summary = JSON.parse(m[1]); } catch { return null; }
  const actionItems: ActionItem[] = [];
  const re = /\{\s*"task"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"owner"\s*:\s*("(?:[^"\\]|\\.)*")\s*(?:,\s*"at"\s*:\s*("(?:[^"\\]|\\.)*")\s*)?\}/g;
  for (let a; (a = re.exec(raw)); ) {
    try {
      const task = String(JSON.parse(a[1])).trim();
      if (task) {
        actionItems.push({
          task, owner: String(JSON.parse(a[2])).trim() || "Unassigned", ...actionTimes(a[3] ? JSON.parse(a[3]) : ""),
        });
      }
    } catch { /* skip a malformed item */ }
  }
  return { summary: summary.trim(), actionItems };
}

export function parseSummary(raw: string): SummarizeResult {
  let data: any;
  try { data = JSON.parse(stripJsonFences(raw)); } catch {
    const salvaged = salvageSummary(raw);
    if (salvaged) return salvaged;
    // Never store JSON-looking text as the summary itself.
    if (/^\s*(```|\{)/.test(raw)) throw new Error("Claude returned a summary that could not be read. Try again.");
    return { summary: raw.trim(), actionItems: [] };
  }
  const actionItems: ActionItem[] = Array.isArray(data?.actionItems)
    ? data.actionItems
        .map((a: any) => ({
          task: String(a?.task ?? "").trim(), owner: String(a?.owner ?? "").trim() || "Unassigned", ...actionTimes(a?.at),
        }))
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
    input.transcript
      ? `Transcript (speakers labeled by name where known; each turn starts with its [mm:ss] time where known):\n${input.transcript}`
      : "Transcript: (none)",
    "",
    input.notes ? `Typed notes:\n${input.notes}` : "Typed notes: (none)",
  ].filter(Boolean);
  if (!input.transcript && !input.notes) {
    throw new Error("Nothing to summarize yet — record a transcript or type notes first.");
  }
  // A long topic (a whole-meeting recording can put an hour under one item)
  // yields a long summary and a dozen-plus action items; 1024 tokens cut it off.
  return parseSummary(await callClaude(pool, SUMMARIZE_SYSTEM, parts.join("\n"), 4096));
}

export interface ReportBodyItem {
  title: string;
  description: string;
  presentedBy: string; // the exact "Presented by" text, "" when nobody is named
  summary: string;
  actionItems: ActionItem[];
  notes: string;
  transcript: string;
}

export interface ReportBodyInput {
  title: string;
  meetingDate: string;
  location: string;
  present: string[];
  guests: string[]; // "Name (Title)"
  items: ReportBodyItem[];
}

const REPORT_SYSTEM = `You are a church meeting secretary writing the official
minutes of a meeting from its full record: for each agenda item, the
transcript, typed notes, an earlier per-item summary, and extracted action
items.

Minutes record what was reported, what was decided, and what happens next.
They are a summary, not a retelling of the discussion. Use the transcript and
notes for the facts; the per-item summaries are a starting point.

Length: the whole body is at most about 2,500 words, so the finished minutes
come to 5–7 pages at most. Each agenda item gets about 150–300 words (half to
three-quarters of a page). Go longer only when an item genuinely needs it, such
as a financial report that walks through several schedules, and even then keep
each schedule to its key figures and comments.

Keep the facts that matter: totals, balances, amounts approved, votes and
motions (who moved, who seconded, the outcome), dates and deadlines, and who
is doing what. Leave out figures that were only read through without comment,
small talk, false starts and repetition. Group related points together.

Write ONLY these sections, in this order, in Markdown:

## Summary
One or two short paragraphs giving the overall picture of the meeting and its
main outcomes.

## Key Decisions
A bullet for each decision, approval, or vote, naming the agenda item it
belongs to in parentheses. Write "None recorded." if there were none.

## Agenda
For each agenda item, in the order given, numbered as given:
### <n>. <title>
**Presented by:** <the presenter text given, exactly> (omit the line when none is given)
Then the item's minutes, organized to fit what was actually presented:
- When the presenter went through several distinct reports, documents,
  statements or schedules (for example a financial report covering Schedule A,
  Schedule B and Schedule C, or reports from separate ministries), give each
  one its own "#### <name>" sub-heading in the order presented, with its own
  key figures and comments under it. Name each one as the speaker did. End
  each "####" line with the stretch of the recording it covers, written
  [start-end] and copying the [mm:ss] stamps at the start of that item's
  transcript turns exactly as written (past the first hour they read h:mm:ss,
  e.g. [1:10:03-1:14:20]); leave it off when the transcript has no stamps.
  Then put any discussion, decisions and follow-up that concern the item as a
  whole after them.
- Otherwise, use whichever of these labelled groups have content, each label
  on its own line followed by bullets:
  **Report:** what the presenter reported
  **Discussion:** the main points raised, and by whom where it matters
  **Decisions:** what was decided or approved
  **Follow-up:** what is to happen next, by whom and by when
An item with no record gets the single line "No discussion recorded."

## Open Questions
Bullets for anything left unresolved or deferred to a later meeting. Omit this
section entirely when there are none.

Formatting rules: only "##", "###" and "####" headings, plain paragraphs,
"- " bullets (never nested or indented), and **bold**. Put each figure on its
own bullet as "**Label:** value" so amounts are easy to scan. No tables, no
numbered lists, no italics, no links, no horizontal rules. Do not write a
title, the date, attendance, or a list of action items; those are added
separately.

Base everything strictly on the material provided. Never invent people,
facts, figures, or decisions; if a figure was unclear in the recording, leave
it out rather than guess. Refer to people by the names used in the
material. Never write a recording timestamp ([mm:ss]) anywhere except at the
end of a "####" line, and nothing after the title on a "###" line. Times of
day that were said in the meeting ("adjourned at 8:47 PM", "next meeting at
7:00 PM") are part of the minutes; keep them.`;

// The organization's own guidance, from Settings, added to the system prompt:
// standing instructions, and a past report to take the pattern from.
export function reportSystemPrompt(instructions: string, example: string): string {
  const parts = [REPORT_SYSTEM];
  if (instructions.trim()) {
    parts.push(`The organization has given these standing instructions for its minutes.
Follow them; where they conflict with the layout above, they win, except that
you must still never invent anything and must still leave out the title,
attendance and action item list.

<instructions>
${instructions.trim()}
</instructions>`);
  }
  if (example.trim()) {
    parts.push(`Here is a past report the organization considers a good example. Match its
structure, level of detail and tone for comparable items (for instance, if it
breaks the financial report into one section per schedule, do the same). It may
include a title, attendance and action items; ignore those parts. It describes
a different meeting: never copy its names, figures or facts.

<example_report>
${example.trim()}
</example_report>`);
  }
  return parts.join("\n\n");
}

// Write the body of the meeting minutes: summary, decisions, the agenda
// written up item by item, and open questions. Every transcript goes in whole;
// the model's context comfortably holds a long meeting.
export async function generateReportBody(pool: Pool, input: ReportBodyInput): Promise<string> {
  const lines: string[] = [`Meeting: ${input.title}`];
  if (input.meetingDate) lines.push(`Date: ${input.meetingDate}`);
  if (input.location) lines.push(`Location: ${input.location}`);
  lines.push(`Present: ${input.present.length ? input.present.join(", ") : "(none recorded)"}`);
  if (input.guests.length) lines.push(`Guests: ${input.guests.join(", ")}`);
  lines.push("", "Agenda items:");
  input.items.forEach((it, i) => {
    lines.push("", `=== Item ${i + 1}: ${it.title} ===`);
    if (it.description) lines.push(`Agenda details: ${it.description}`);
    lines.push(`Presented by: ${it.presentedBy || "(none given)"}`);
    if (!it.summary && !it.notes && !it.transcript) { lines.push("(no record)"); return; }
    if (it.summary) lines.push(`Earlier summary:\n${it.summary}`);
    if (it.actionItems.length) {
      lines.push("Action items already extracted:");
      it.actionItems.forEach((a) => lines.push(`- ${a.task} (owner: ${a.owner})`));
    }
    if (it.notes) lines.push(`Typed notes:\n${it.notes}`);
    if (it.transcript) {
      lines.push(`Transcript (speakers labeled by name where known; each turn starts with its [mm:ss] time where known):\n${it.transcript}`);
    }
  });
  const system = reportSystemPrompt(
    await getSetting(pool, "report_instructions"),
    await getSetting(pool, "report_example")
  );
  const body = (await callClaude(pool, system, lines.join("\n"), 16000, REPORT_TIMEOUT_MS)).trim();
  if (!body) throw new Error("Claude returned an empty report. Try again.");
  return body;
}

export interface ReconcileInput {
  meetingTitle: string;
  itemTitle: string;
  transcript: string;      // rendered with positional "Speaker N" labels
  speakerOrder: string[];  // raw labels in first-appearance order
  attendees: string[];     // "Name (Title)" strings for everyone present
  presenters: string[];    // names of this item's presenters
}

const RECONCILE_SYSTEM = `You clean up automatic speaker diarization of a meeting recording.

The transcript labels each turn "Speaker 1", "Speaker 2", and so on. Those
labels are UNRELIABLE in two specific ways: one person is frequently split
across several different labels, and a label sometimes changes in the middle of
a single person's sentence.

You are given the list of people present. Decide which person each label
belongs to. SEVERAL LABELS MAY MAP TO THE SAME PERSON — that is the common case
and the main thing you are here to fix. Merge labels whenever the content reads
as one continuous speaker. Evidence to use: direct address ("Thanks, Alice"),
self-introduction, who answers which question, a person's stated role, and who
owns which topic.

Respond with ONLY a JSON object, no prose around it, mapping every label to a
person's name — the name only, WITHOUT any parenthetical title, copied exactly
from the list of people present — or to "" when you genuinely cannot tell:
{ "Speaker 1": "Alice Smith", "Speaker 2": "Alice Smith", "Speaker 3": "" }

Never output a name that is not in the list of people present. Prefer "" over a
guess. Include every label exactly once.`;

// Translate Claude's positional answer back into raw diarization labels.
// Labels outside speakerOrder and names outside allowedNames are dropped, so a
// malformed or hallucinated response degrades to "no opinion" rather than
// corrupting the speaker map.
export function parseSpeakerMap(raw: string, speakerOrder: string[], allowedNames: string[]): SpeakerMap {
  let data: any;
  try { data = JSON.parse(stripJsonFences(raw)); } catch { return {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const allowed = new Map(allowedNames.map((n) => [n.trim().toLowerCase(), n.trim()]));
  const out: SpeakerMap = {};
  for (const [key, value] of Object.entries(data)) {
    const m = /^\s*speaker\s*(\d+)\s*$/i.exec(key);
    if (!m) continue;
    const label = speakerOrder[Number(m[1]) - 1];
    if (!label) continue;
    const candidate = String(value ?? "").trim();
    const name = allowed.get(candidate.toLowerCase())
      ?? allowed.get(candidate.replace(/\s*\([^()]*\)\s*$/, "").trim().toLowerCase());
    if (name) out[label] = name;
  }
  return out;
}

// Ask Claude which person each diarized voice belongs to, merging voices that
// the diarizer split apart. Best-effort by contract: every failure path returns
// {} so a transcription is never lost to a reconciliation problem.
export async function reconcileSpeakers(pool: Pool, input: ReconcileInput): Promise<SpeakerMap> {
  if (!input.speakerOrder.length || !input.transcript.trim() || !input.attendees.length) return {};
  const names = input.attendees.map((a) => a.replace(/\s*\([^()]*\)\s*$/, "").trim()).filter(Boolean);
  const parts = [
    `Meeting: ${input.meetingTitle}`,
    `Agenda item: ${input.itemTitle}`,
    `People present: ${input.attendees.join(", ")}`,
    input.presenters.length
      ? `Expected to lead this item: ${input.presenters.join(", ")}`
      : "Expected to lead this item: unspecified",
    `Labels to assign: ${input.speakerOrder.map((_, i) => `Speaker ${i + 1}`).join(", ")}`,
    "",
    "Transcript:",
    input.transcript,
  ];
  try {
    // A long recording is transcribed in parts, each with its own labels, so
    // the answer can list dozens of labels; leave room for all of them.
    const maxTokens = Math.min(4096, Math.max(1024, 256 + 32 * input.speakerOrder.length));
    const raw = await callClaude(pool, RECONCILE_SYSTEM, parts.join("\n"), maxTokens);
    return parseSpeakerMap(raw, input.speakerOrder, names);
  } catch {
    return {};
  }
}
