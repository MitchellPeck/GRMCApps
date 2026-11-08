// Grace Notes paste sheet: the issue as email-ready blocks, in section order, with unchanged ones flagged.
import { Pool, PoolClient } from "pg";
import { Issue, getIssue, glanceHtml, listIssues } from "./issues";
import { Result } from "../pipeline/rules";
import { effectiveImage, listPieces } from "./pieces";
import { htmlToText } from "./html";
import { listSections, withTx } from "./repo";
import { Piece, SectionKind } from "./types";

type Db = Pool | PoolClient;

export interface SheetBlock {
  sectionId: string; title: string; kind: SectionKind; unchanged: boolean;
  html: string; text: string; images: Array<{ url: string; alt: string }>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeLink = (s: string) => /^(https?:\/\/|mailto:)\S+$/i.test(s.trim());
const itemTitle = (p: Piece) => (p.eventId && p.eventName ? p.eventName : p.title);

function itemHtml(p: Piece): string {
  const d = p.details;
  const title = itemTitle(p);
  const meta = [d.when, d.place, d.cost].map((x) => String(x ?? "").trim()).filter(Boolean).map(esc).join(" · ");
  const link = String(d.link ?? "").trim();
  const label = String(d.linkLabel ?? "").trim() || "Register here";
  const contact = String(d.contact ?? "").trim();
  return [
    title ? `<p><strong>${esc(title)}</strong></p>` : "",
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
    out.push({ sectionId: s.id, title: s.title, kind: s.kind, unchanged: false, html, text: htmlToText(html), images });
  }
  return out;
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
