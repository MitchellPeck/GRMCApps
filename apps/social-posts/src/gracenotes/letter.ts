// Grace Notes: Claude's review of the pastor's letter. It suggests small fixes; a person accepts or rejects each one.
import { randomBytes } from "node:crypto";
import { Pool, PoolClient } from "pg";
import { callClaude } from "../claude";
import { Result } from "../pipeline/rules";
import { glanceHtml, getIssue, listIssues } from "./issues";
import { htmlToText } from "./html";
import { editPiece, getPiece, listPieces } from "./pieces";
import { withTx } from "./repo";

type Db = Pool | PoolClient;
type Call = typeof callClaude;

export interface Suggestion {
  id: string; kind: "grammar" | "fact"; original: string; replacement: string; reason: string; source: string;
  state: "open" | "accepted" | "rejected" | "missed";
}
export interface ReviewFacts { glance: string; sermon: string; events: string[]; previousLetter: string }

const MAX_SUGGESTIONS = 25;
const LETTER_TITLE = /pastor|message|letter/i;
const STALE = "That sentence has changed since the review. Edit it by hand.";

export function buildReviewPrompt(letterText: string, facts: ReviewFacts): { system: string; user: string } {
  const system = [
    "You proofread the pastor's weekly letter for a church email.",
    "Fix only grammar, spelling, punctuation and clear factual mismatches with the facts given.",
    "Keep the pastor's voice and wording. Do not rewrite, restyle, shorten or improve anything else.",
    "Each suggestion's `original` must be quoted exactly from the letter and be as short as possible.",
    "Use kind \"grammar\" for grammar, spelling and punctuation (leave `source` empty), and kind \"fact\" for a mismatch with the facts (set `source` to what it was checked against, e.g. \"Grace at a Glance: Stewardship Sunday, Nov 8\").",
    `Never return more than ${MAX_SUGGESTIONS} suggestions. If the letter is fine, return an empty list.`,
  ].join("\n");
  const user = [
    "LETTER:", letterText, "",
    "FACTS - Grace at a Glance (upcoming dates):", facts.glance || "(none)", "",
    "FACTS - This week's sermon:", facts.sermon || "(none)", "",
    "FACTS - Events in this issue:", facts.events.length ? facts.events.map((e) => `- ${e}`).join("\n") : "(none)", "",
    "FACTS - Last issue's letter (for context, not to be checked):", facts.previousLetter || "(none)",
  ].join("\n");
  return { system, user };
}

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["kind", "original", "replacement", "reason", "source"],
        properties: {
          kind: { type: "string", enum: ["grammar", "fact"] },
          original: { type: "string" }, replacement: { type: "string" }, reason: { type: "string" }, source: { type: "string" },
        },
      },
    },
  },
};

async function gatherFacts(db: Db, issueId: string): Promise<ReviewFacts> {
  const issue = await getIssue(db, issueId);
  if (!issue) throw new Error("Issue not found.");
  const pieces = (await listPieces(db, issueId)).filter((p) => p.status !== "dropped");
  const sermon = pieces.filter((p) => /sermon/i.test(p.sectionTitle) && p.sectionKind === "text")
    .map((p) => `${p.title}\n${htmlToText(p.bodyHtml)}`.trim()).join("\n\n");
  const events = pieces.filter((p) => p.sectionKind === "events").map((p) => {
    const when = p.eventStartDate || p.details.when || "";
    return `${p.title || p.eventName || "(untitled)"}${when ? ` (${when})` : ""}`;
  });
  const previous = (await listIssues(db)).filter((i) => i.issueDate < issue.issueDate)
    .sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1))[0];
  let previousLetter = "";
  if (previous) {
    previousLetter = (await listPieces(db, previous.id))
      .filter((p) => p.status !== "dropped" && p.sectionKind === "text" && LETTER_TITLE.test(p.sectionTitle))
      .map((p) => htmlToText(p.bodyHtml)).join("\n\n");
  }
  return { glance: htmlToText(await glanceHtml(db, issue.issueDate)), sermon, events, previousLetter };
}

export async function reviewLetter(db: Pool, pieceId: string, call: Call = callClaude): Promise<Suggestion[]> {
  const piece = await getPiece(db, pieceId);
  if (!piece) throw new Error("Piece not found.");
  if (piece.sectionKind !== "text") throw new Error("Only text pieces can be reviewed.");
  const { system, user } = buildReviewPrompt(htmlToText(piece.bodyHtml), await gatherFacts(db, piece.issueId));
  const raw = await call(db, system, user, { schema: SCHEMA, maxTokens: 4000 });
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Claude's review wasn't readable. Try again."); }
  const list: Suggestion[] = (Array.isArray(parsed?.suggestions) ? parsed.suggestions : [])
    .filter((s: any) => s && typeof s.original === "string" && s.original && typeof s.replacement === "string" && s.original !== s.replacement)
    .slice(0, MAX_SUGGESTIONS)
    .map((s: any) => ({
      id: randomBytes(6).toString("hex"), kind: s.kind === "fact" ? "fact" : "grammar",
      original: s.original, replacement: s.replacement, reason: String(s.reason ?? ""),
      source: s.kind === "fact" ? String(s.source ?? "") : "", state: "open" as const,
    }));
  await db.query(
    `INSERT INTO gn_letter_reviews (piece_id, suggestions, created_at) VALUES ($1,$2::jsonb, now())
     ON CONFLICT (piece_id) DO UPDATE SET suggestions = EXCLUDED.suggestions, created_at = now()`,
    [pieceId, JSON.stringify(list)]);
  return list;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escQuoted = (s: string) => escText(s).replace(/"/g, "&quot;");

/** Replace the first match of `original` that sits inside a text node; tags and attributes are never touched. */
export function applySuggestion(html: string, s: Suggestion): { html: string; applied: boolean } {
  if (!s.original) return { html, applied: false };
  const parts = html.split(/(<[^>]*>)/);
  const forms: Array<[string, string]> = [[escText(s.original), escText(s.replacement)], [escQuoted(s.original), escQuoted(s.replacement)]];
  for (let i = 0; i < parts.length; i += 2) {
    for (const [from, to] of forms) {
      const at = parts[i].indexOf(from);
      if (at < 0) continue;
      parts[i] = parts[i].slice(0, at) + to + parts[i].slice(at + from.length);
      return { html: parts.join(""), applied: true };
    }
  }
  return { html, applied: false };
}

export async function decideSuggestion(
  db: Pool, pieceId: string, suggestionId: string, decision: "accepted" | "rejected", actorEmail: string,
): Promise<Result<Suggestion>> {
  return withTx(db, async (c) => {
    const { rows } = await c.query("SELECT suggestions FROM gn_letter_reviews WHERE piece_id = $1 FOR UPDATE", [pieceId]);
    if (!rows[0]) return { ok: false as const, error: "There's no review for this piece." };
    const list = rows[0].suggestions as Suggestion[];
    const s = list.find((x) => x.id === suggestionId);
    if (!s) return { ok: false as const, error: "That suggestion no longer exists." };
    if (s.state !== "open") return { ok: false as const, error: "That suggestion was already handled." };
    const save = () => c.query("UPDATE gn_letter_reviews SET suggestions = $2::jsonb WHERE piece_id = $1", [pieceId, JSON.stringify(list)]);

    if (decision === "rejected") { s.state = "rejected"; await save(); return { ok: true as const, value: s }; }

    const piece = await getPiece(c, pieceId);
    if (!piece) return { ok: false as const, error: "Piece not found." };
    const r = applySuggestion(piece.bodyHtml, s);
    if (!r.applied) { s.state = "missed"; await save(); return { ok: false as const, error: STALE }; }
    const edited = await editPiece(c, pieceId, { bodyHtml: r.html }, { kind: "admin", email: actorEmail });
    if (!edited.ok) return { ok: false as const, error: edited.error };
    s.state = "accepted";
    await save();
    return { ok: true as const, value: s };
  });
}
