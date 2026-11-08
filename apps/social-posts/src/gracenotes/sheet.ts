// Grace Notes paste sheet: the issue as email-ready blocks, in section order, with unchanged ones flagged.
import { Pool, PoolClient } from "pg";
import { getIssue, glanceHtml, listIssues, pieceHash } from "./issues";
import { effectiveImage, listPieces } from "./pieces";
import { htmlToText } from "./html";
import { listSections } from "./repo";
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

/** True when every live piece is carried/confirmed unchanged from the previous issue and nothing was added or dropped. */
function piecesUnchanged(live: Piece[], prevAll: Piece[] | null, sectionId: string): boolean {
  if (!prevAll) return false;
  const prevById = new Map(prevAll.filter((p) => p.sectionId === sectionId).map((p) => [p.id, p]));
  const used = new Set<string>();
  for (const p of live) {
    if (p.status !== "carried" && p.status !== "confirmed") return false;
    const src = p.carriedFrom ? prevById.get(p.carriedFrom) : undefined;
    if (!src || src.status === "dropped") return false;
    if (pieceHash(p) !== pieceHash(src)) return false;
    used.add(src.id);
  }
  return [...prevById.values()].every((p) => p.status === "dropped" || used.has(p.id));
}

export async function buildSheet(db: Db, issueId: string): Promise<SheetBlock[]> {
  const issue = await getIssue(db, issueId);
  if (!issue) return [];
  const prevIssue = (await listIssues(db)).find((i) => i.issueDate < issue.issueDate) ?? null; // newest first
  const pieces = await listPieces(db, issueId);
  const prevPieces = prevIssue ? await listPieces(db, prevIssue.id) : null;
  const sections = (await listSections(db, { includeRetired: false })).sort((a, b) => a.position - b.position);

  const out: SheetBlock[] = [];
  for (const s of sections) {
    const live = pieces
      .filter((p) => p.sectionId === s.id && p.status !== "dropped")
      .sort((a, b) => a.position - b.position);
    let html: string;
    let unchanged: boolean;
    if (s.kind === "glance") {
      html = await glanceHtml(db, issue.issueDate);
      unchanged = prevIssue ? html === (await glanceHtml(db, prevIssue.issueDate)) : false;
    } else {
      html = s.kind === "events" ? live.map(itemHtml).join("") : live.map((p) => p.bodyHtml).join("");
      unchanged = piecesUnchanged(live, prevPieces, s.id);
    }
    const images = s.kind === "glance" ? [] : live
      .map((p) => ({ url: effectiveImage(p), alt: itemTitle(p) }))
      .filter((i) => i.url);
    out.push({ sectionId: s.id, title: s.title, kind: s.kind, unchanged, html, text: htmlToText(html), images });
  }
  return out;
}
