// Grace Notes paste sheet: the issue as email-ready blocks, in section order, with unchanged ones flagged.
import { Pool, PoolClient } from "pg";
import { Issue, getIssue, glanceHtml, label as dayLabel, listIssues } from "./issues";
import { Result } from "../pipeline/rules";
import { effectiveImage, listPieces } from "./pieces";
import { htmlToText } from "./html";
import { LETTER_TITLE } from "./letter";
import { LetterVersions, bodiesOf } from "./letter-versions";
import { listSections, withTx } from "./repo";
import { Piece, SectionKind } from "./types";

type Db = Pool | PoolClient;

/** One thing to paste into one Mailchimp block: a heading (plain text) or a body (rich text). */
export interface SheetPart {
  key: string; kind: "heading" | "body"; label: string; html: string; text: string;
  image?: { url: string; alt: string }; note?: string;
}
export interface SheetBlock {
  sectionId: string; title: string; kind: SectionKind; unchanged: boolean;
  html: string; text: string; images: Array<{ url: string; alt: string }>;
  /** The section in paste order: its heading, then its body (events: each item's title and text). */
  parts: SheetPart[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeLink = (s: string) => /^(https?:\/\/|mailto:)\S+$/i.test(s.trim());
const itemTitle = (p: Piece) => (p.eventId && p.eventName ? p.eventName : p.title);

function itemHtml(p: Piece): string {
  const title = itemTitle(p);
  return (title ? `<p><strong>${esc(title)}</strong></p>` : "") + itemBodyHtml(p);
}

/** An event item without its name: date and details, its text, then the link and contact. */
function itemBodyHtml(p: Piece): string {
  const d = p.details;
  // The date lives on the event (the editors' date picker); `when` is only the time.
  const s = p.eventStartDate ?? "", e = p.eventEndDate ?? "";
  const date = s ? (e && e > s ? `${dayLabel(s)} – ${dayLabel(e)}` : dayLabel(s)) : "";
  const meta = [date, d.when, d.place, d.cost].map((x) => String(x ?? "").trim()).filter(Boolean).map(esc).join(" · ");
  const link = String(d.link ?? "").trim();
  const label = String(d.linkLabel ?? "").trim() || "Register here";
  const contact = String(d.contact ?? "").trim();
  return [
    meta ? `<p>${meta}</p>` : "",
    p.bodyHtml,
    link && safeLink(link) ? `<p><a href="${esc(link)}">${esc(label)}</a></p>` : "",
    contact ? `<p>Contact: ${esc(contact)}</p>` : "",
  ].join("");
}

/** Render an issue from live data, with every block marked changed. */
async function renderSheet(db: Db, issueId: string): Promise<SheetBlock[]> {
  const issue = await getIssue(db, issueId);
  if (!issue) return [];
  const pieces = await listPieces(db, issueId);
  const sections = (await listSections(db, { includeRetired: false })).sort((a, b) => a.position - b.position);
  const out: SheetBlock[] = [];
  for (const s of sections) {
    const live = pieces
      .filter((p) => p.sectionId === s.id && p.status !== "dropped")
      .sort((a, b) => a.position - b.position);
    const html = s.kind === "glance" ? await glanceHtml(db, issue.issueDate)
      : s.kind === "events" ? live.map(itemHtml).join("") : live.map((p) => p.bodyHtml).join("");
    const images = s.kind === "glance" ? [] : live
      .map((p) => ({ url: effectiveImage(p), alt: itemTitle(p) }))
      .filter((i) => i.url);
    out.push({ sectionId: s.id, title: s.title, kind: s.kind, unchanged: false, html, text: htmlToText(html), images,
      parts: await partsOf(db, s, live, html) });
  }
  return out;
}

const heading = (key: string, label: string, text: string): SheetPart => ({ key, kind: "heading", label, html: esc(text), text });
const body = (key: string, label: string, html: string, extra: Partial<SheetPart> = {}): SheetPart =>
  ({ key, kind: "body", label, html, text: htmlToText(html), ...extra });

async function partsOf(db: Db, s: { id: string; title: string; kind: SectionKind }, live: Piece[], html: string): Promise<SheetPart[]> {
  const k = (x: string) => `${s.id}:${x}`;
  if (s.kind === "events") {
    return [heading(k("h"), "Section heading", s.title), ...live.flatMap((p, i) => {
      const img = effectiveImage(p);
      return [
        heading(k(`${p.id}:h`), `Item ${i + 1} title`, itemTitle(p) || "(untitled)"),
        body(k(`${p.id}:b`), `Item ${i + 1} text`, itemBodyHtml(p), img ? { image: { url: img, alt: itemTitle(p) } } : {}),
      ];
    })];
  }
  // The pastor's letter, once its email versions are made: their headline, and both bodies to choose from.
  if (s.kind === "text" && LETTER_TITLE.test(s.title) && live.length === 1) {
    const r = await db.query("SELECT versions FROM gn_letter_reviews WHERE piece_id = $1", [live[0].id]);
    const v = r.rows[0]?.versions as LetterVersions | null | undefined;
    if (v) {
      const b = bodiesOf(v);
      const note = v.sourceHtml !== live[0].bodyHtml ? "The letter changed after these were made. Remake them on the letter above." : undefined;
      return [heading(k("h"), "Headline", v.title || s.title),
        { ...body(k("short"), "Short email cut", b.shortHtml), text: b.shortText, note },
        { ...body(k("full"), "Full letter", b.fullHtml), text: b.fullText, note }];
    }
  }
  const img = s.kind === "text" ? live.map(effectiveImage).find(Boolean) : undefined;
  return [heading(k("h"), "Heading", s.title), body(k("b"), "Text", html, img ? { image: { url: img, alt: s.title } } : {})];
}

type Snap = Array<{ sectionId: string; html: string; images: Array<{ url: string; alt: string }> }>;

/** `unchanged` means the block is identical to the previous email's block at the same position. */
export async function buildSheet(db: Db, issueId: string): Promise<SheetBlock[]> {
  const issue = await getIssue(db, issueId);
  if (!issue) return [];
  const blocks = await renderSheet(db, issueId);
  const prevIssue = (await listIssues(db)).find((i) => i.issueDate < issue.issueDate) ?? null; // newest first
  if (!prevIssue) return blocks;
  const snap = (await db.query("SELECT sheet_snapshot FROM gn_issues WHERE id = $1", [prevIssue.id])).rows[0]?.sheet_snapshot as Snap | null;
  const prev: Snap = snap ?? (await renderSheet(db, prevIssue.id));
  const urls = (im: Array<{ url: string }>) => JSON.stringify(im.map((i) => i.url));
  blocks.forEach((b, i) => {
    const q = prev[i];
    b.unchanged = !!q && q.sectionId === b.sectionId && q.html === b.html && urls(q.images) === urls(b.images);
  });
  return blocks;
}

/** Freeze what the email looked like, so next week's "unchanged" compares against what went out. */
export async function markIssueSent(db: Db, issueId: string): Promise<Result<Issue>> {
  return withTx(db, async (c): Promise<Result<Issue>> => {
    const locked = await c.query("SELECT status FROM gn_issues WHERE id = $1 FOR UPDATE", [issueId]);
    if (!locked.rows[0]) return { ok: false, error: "Issue not found." };
    if (locked.rows[0].status === "sent") return { ok: false, error: "That issue was already marked sent." };
    const snap: Snap = (await renderSheet(c, issueId)).map((b) => ({ sectionId: b.sectionId, html: b.html, images: b.images }));
    await c.query("UPDATE gn_issues SET status = 'sent', sent_at = now(), sheet_snapshot = $2 WHERE id = $1", [issueId, JSON.stringify(snap)]);
    return { ok: true, value: (await getIssue(c, issueId))! };
  });
}

/** Undo "Mark sent": the issue can be edited again, and its frozen snapshot is dropped until it's re-sent. */
export async function unmarkIssueSent(db: Db, issueId: string): Promise<Result<Issue>> {
  return withTx(db, async (c): Promise<Result<Issue>> => {
    const locked = await c.query("SELECT status FROM gn_issues WHERE id = $1 FOR UPDATE", [issueId]);
    if (!locked.rows[0]) return { ok: false, error: "Issue not found." };
    if (locked.rows[0].status !== "sent") return { ok: false, error: "That issue isn't marked sent." };
    await c.query("UPDATE gn_issues SET status = 'collecting', sent_at = NULL, sheet_snapshot = NULL WHERE id = $1", [issueId]);
    return { ok: true, value: (await getIssue(c, issueId))! };
  });
}
