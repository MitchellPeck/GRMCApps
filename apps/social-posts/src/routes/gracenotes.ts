// Grace Notes admin API. It sits behind the hub login; contributors use routes/contributor.ts instead.
import { FastifyInstance, FastifyRequest } from "fastify";
import { Pool } from "pg";
import { pool as appPool } from "../db";
import { getIdentity } from "../identity";
import { getSetting } from "../settings";
import {
  createContributor, createSection, listContributors, listSections, reorderSections, retireContributor,
  setSectionOwners, updateContributor, updateSection,
} from "../gracenotes/repo";
import { contributorStatus, createIssue, getIssue, listIssues, fillOpenIssues } from "../gracenotes/issues";
import { Actor, PieceInput, addExistingEvent, addItem, confirmPiece, dropPiece, editPiece, linkEvent, listPieces } from "../gracenotes/pieces";
import { decideSuggestion, reviewLetter } from "../gracenotes/letter";
import { buildSheet, markIssueSent } from "../gracenotes/sheet";
import { remind } from "../gracenotes/mail";
import { Contributor } from "../gracenotes/types";

export interface GnRouteOpts { db?: Pool }

// Same shape as routes/pipeline.ts: { ok: true, ... } or { ok: false, error }.
export async function guard<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try { return await fn(); }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

const body = (req: FastifyRequest): Record<string, unknown> =>
  req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
const params = (req: FastifyRequest) => req.params as Record<string, string>;

/** Only the fields a piece edit may carry; anything else in the body (status, owner...) is ignored. */
export function pieceInput(raw: Record<string, unknown>): PieceInput {
  const out: PieceInput = {};
  if (typeof raw.title === "string") out.title = raw.title;
  if (typeof raw.bodyHtml === "string") out.bodyHtml = raw.bodyHtml;
  if (raw.details && typeof raw.details === "object" && !Array.isArray(raw.details)) out.details = raw.details as PieceInput["details"];
  if (typeof raw.imageUrl === "string") out.imageUrl = raw.imageUrl;
  if (typeof raw.startDate === "string") out.startDate = raw.startDate;
  if ("endDate" in raw && (raw.endDate === null || typeof raw.endDate === "string")) out.endDate = raw.endDate as string | null;
  return out;
}

export async function gracenotesRoutes(app: FastifyInstance, opts: GnRouteOpts = {}): Promise<void> {
  const db = opts.db ?? appPool;
  const admin = (req: FastifyRequest): Actor => ({ kind: "admin", email: getIdentity(req).email });

  async function linkBase(req: FastifyRequest): Promise<string> {
    const set = (await getSetting(db, "public_base_url")).trim().replace(/\/+$/, "");
    return set || `https://${req.hostname}`;
  }
  const withLink = (base: string, c: Contributor) => {
    const { token, ...rest } = c;
    return { ...rest, link: `${base}/gn/${token}` };
  };

  // ── Contributors ──
  app.get("/api/gracenotes/contributors", async (req) => guard(async () => {
    const base = await linkBase(req);
    return { ok: true, contributors: (await listContributors(db)).map((c) => withLink(base, c)) };
  }));
  app.post("/api/gracenotes/contributors", async (req) => guard(async () => {
    const b = body(req);
    const r = await createContributor(db, { name: String(b.name ?? ""), email: typeof b.email === "string" ? b.email : undefined });
    return r.ok ? { ok: true, contributor: withLink(await linkBase(req), r.value) } : r;
  }));
  app.patch("/api/gracenotes/contributors/:id", async (req) => guard(async () => {
    const b = body(req);
    const r = await updateContributor(db, params(req).id, {
      name: typeof b.name === "string" ? b.name : undefined, email: typeof b.email === "string" ? b.email : undefined });
    return r.ok ? { ok: true, contributor: withLink(await linkBase(req), r.value) } : r;
  }));
  app.post("/api/gracenotes/contributors/:id/retire", async (req) => guard(async () => {
    const r = await retireContributor(db, params(req).id);
    return r.ok ? { ok: true, contributor: withLink(await linkBase(req), r.value) } : r;
  }));

  // ── Sections ──
  app.get("/api/gracenotes/sections", async () => guard(async () => ({ ok: true, sections: await listSections(db, { includeRetired: true }) })));
  app.post("/api/gracenotes/sections", async (req) => guard(async () => {
    const b = body(req);
    const r = await createSection(db, { title: String(b.title ?? ""), kind: b.kind as never });
    if (r.ok) await fillOpenIssues(db);
    return r.ok ? { ok: true, section: r.value } : r;
  }));
  app.post("/api/gracenotes/sections/order", async (req) => guard(async () => {
    const ids = body(req).ids;
    if (!Array.isArray(ids)) return { ok: false as const, error: "Send the section ids in order." };
    const r = await reorderSections(db, ids.map(String));
    return r.ok ? { ok: true, sections: await listSections(db, { includeRetired: true }) } : r;
  }));
  app.patch("/api/gracenotes/sections/:id", async (req) => guard(async () => {
    const b = body(req);
    const r = await updateSection(db, params(req).id, {
      title: typeof b.title === "string" ? b.title : undefined, retired: typeof b.retired === "boolean" ? b.retired : undefined });
    if (r.ok && b.retired === false) await fillOpenIssues(db);
    return r.ok ? { ok: true, section: r.value } : r;
  }));
  app.put("/api/gracenotes/sections/:id/owners", async (req) => guard(async () => {
    const ids = body(req).contributorIds;
    if (!Array.isArray(ids)) return { ok: false as const, error: "Send contributorIds as a list." };
    const r = await setSectionOwners(db, params(req).id, ids.map(String));
    return r.ok ? { ok: true, sections: await listSections(db, { includeRetired: true }) } : r;
  }));

  // ── Issues ──
  app.get("/api/gracenotes/issues", async () => guard(async () => ({ ok: true, issues: await listIssues(db) })));
  app.post("/api/gracenotes/issues", async (req) => guard(async () => {
    const r = await createIssue(db, String(body(req).issueDate ?? ""));
    return r.ok ? { ok: true, issue: r.value } : r;
  }));
  app.get("/api/gracenotes/issues/:id", async (req) => guard(async () => {
    const id = params(req).id;
    const issue = await getIssue(db, id);
    if (!issue) return { ok: false as const, error: "Issue not found." };
    if (issue.status === "collecting") await fillOpenIssues(db);
    const pieces = await listPieces(db, id);
    const { rows } = await db.query(
      "SELECT piece_id, suggestions FROM gn_letter_reviews WHERE piece_id = ANY($1)", [pieces.map((p) => p.id)]);
    const reviews: Record<string, unknown> = {};
    for (const r of rows) reviews[r.piece_id] = r.suggestions;
    return { ok: true, issue, pieces, contributors: await contributorStatus(db, id), reviews };
  }));
  // The sheet is what gets pasted into Mailchimp; marking it sent stores a snapshot (markIssueSent).
  app.post("/api/gracenotes/issues/:id/sent", async (req) => guard(async () => {
    const r = await markIssueSent(db, params(req).id);
    return r.ok ? { ok: true, issue: r.value } : r;
  }));
  app.get("/api/gracenotes/issues/:id/sheet", async (req) => guard(async () => {
    if (!(await getIssue(db, params(req).id))) return { ok: false as const, error: "Issue not found." };
    return { ok: true, blocks: await buildSheet(db, params(req).id) };
  }));
  app.post("/api/gracenotes/issues/:id/sections/:sid/items", async (req) => guard(async () => {
    const r = await addItem(db, params(req).id, params(req).sid, pieceInput(body(req)), admin(req));
    return r.ok ? { ok: true, piece: r.value } : r;
  }));
  app.post("/api/gracenotes/issues/:id/sections/:sid/items/from-event", async (req) => guard(async () => {
    const r = await addExistingEvent(db, params(req).id, params(req).sid, String(body(req).eventId ?? ""), admin(req));
    return r.ok ? { ok: true, piece: r.value } : r;
  }));
  app.post("/api/gracenotes/issues/:id/remind/:contributorId", async (req) => guard(async () => {
    const r = await remind(db, params(req).id, params(req).contributorId, "manual");
    return r.status === "sent" ? { ok: true, status: r.status } : { ok: false as const, error: r.error || "The email didn't send.", status: r.status };
  }));

  // ── Pieces ──
  app.post("/api/gracenotes/pieces/:id/confirm", async (req) => guard(async () => {
    const r = await confirmPiece(db, params(req).id, admin(req));
    return r.ok ? { ok: true, piece: r.value } : r;
  }));
  app.post("/api/gracenotes/pieces/:id/edit", async (req) => guard(async () => {
    const r = await editPiece(db, params(req).id, pieceInput(body(req)), admin(req));
    return r.ok ? { ok: true, piece: r.value } : r;
  }));
  app.post("/api/gracenotes/pieces/:id/drop", async (req) => guard(async () => {
    const r = await dropPiece(db, params(req).id, admin(req));
    return r.ok ? { ok: true, piece: r.value } : r;
  }));
  app.post("/api/gracenotes/pieces/:id/link", async (req) => guard(async () => {
    const r = await linkEvent(db, params(req).id, String(body(req).eventId ?? ""));
    return r.ok ? { ok: true, piece: r.value } : r;
  }));
  app.post("/api/gracenotes/pieces/:id/review", async (req) => guard(async () => ({
    ok: true, suggestions: await reviewLetter(db, params(req).id) })));
  app.post("/api/gracenotes/pieces/:id/review/:sid", async (req) => guard(async () => {
    const decision = body(req).decision;
    if (decision !== "accepted" && decision !== "rejected") return { ok: false as const, error: "Decision must be accepted or rejected." };
    const r = await decideSuggestion(db, params(req).id, params(req).sid, decision, getIdentity(req).email);
    return r.ok ? { ok: true, suggestion: r.value } : r;
  }));
}
