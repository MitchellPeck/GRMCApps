import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import Fastify, { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema";
import { createContributor, createSection, retireContributor, setSectionOwners } from "./gracenotes/repo";
import { createIssue } from "./gracenotes/issues";
import { getPiece, listPieces } from "./gracenotes/pieces";
import { Contributor } from "./gracenotes/types";
import { gracenotesRoutes } from "./routes/gracenotes";
import { contributorRoutes } from "./routes/contributor";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const GN = "gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors";
let app: FastifyInstance;

before(async () => {
  await pool.query(SCHEMA_SQL);
  await pool.query(`DROP TABLE IF EXISTS ${GN}`);
  await pool.query(SCHEMA_SQL);
  app = Fastify();
  await app.register(contributorRoutes, { db: pool });
  await app.register(gracenotesRoutes, { db: pool });
  await app.ready();
});
beforeEach(async () => { await pool.query(`TRUNCATE ${GN} CASCADE`); await pool.query("DELETE FROM events WHERE id LIKE 'gntest-%'"); });
after(async () => { await app.close(); await pool.query(`DROP TABLE IF EXISTS ${GN}`); await pool.end(); });

const val = <T>(r: { ok: boolean }) => (r as { ok: true; value: T }).value;
async function person(name: string): Promise<Contributor> { return val<Contributor>(await createContributor(pool, { name, email: `${name}@x.org` })); }

/** Two contributors, each owning a text section, a collecting issue (which opens a blank piece per owned section). */
async function world() {
  const ann = await person("ann"), bob = await person("bob");
  const sa = val<{ id: string }>(await createSection(pool, { title: "Ann's", kind: "text" }));
  const sb = val<{ id: string }>(await createSection(pool, { title: "Bob's", kind: "text" }));
  await setSectionOwners(pool, sa.id, [ann.id]);
  await setSectionOwners(pool, sb.id, [bob.id]);
  const issue = val<{ id: string }>(await createIssue(pool, "2026-11-11"));
  const pieces = await listPieces(pool, issue.id);
  return { ann, bob, sa, sb, issue, pa: pieces.find((p) => p.sectionId === sa.id)!, pb: pieces.find((p) => p.sectionId === sb.id)! };
}

test("gn route rejects retired token", async () => {
  const { ann, pa } = await world();
  await retireContributor(pool, ann.id);
  const page = await app.inject({ url: `/gn/${ann.token}` });
  assert.equal(page.statusCode, 404);
  assert.match(page.body, /This link isn't active\. Ask Mitchell for a new one\./);
  const r = await app.inject({ method: "POST", url: `/gn/${ann.token}/api/pieces/${pa.id}/confirm` });
  assert.equal(r.statusCode, 404);
  assert.equal((await getPiece(pool, pa.id))!.status, pa.status);
  assert.equal((await app.inject({ url: "/gn/nope/api/view" })).statusCode, 404);
});

test("gn view returns own pieces", async () => {
  const { ann, bob, pa, pb } = await world();
  const page = await app.inject({ url: `/gn/${ann.token}` });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers["content-type"]), /html/);
  const r = await app.inject({ url: `/gn/${ann.token}/api/view` });
  const body = r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.pieces.map((p: { id: string }) => p.id), [pa.id]);
  assert.ok(!r.body.includes(bob.token) && !r.body.includes(ann.token) && !r.body.includes(pb.id));
});

test("gn cannot touch others", async () => {
  const { ann, pb } = await world();
  const r = await app.inject({ method: "POST", url: `/gn/${ann.token}/api/pieces/${pb.id}/confirm` });
  assert.deepEqual(r.json(), { ok: false, error: "That piece isn't yours." });
  assert.equal((await getPiece(pool, pb.id))!.status, pb.status);
});

test("gn contributor confirms and edits their own piece", async () => {
  const { ann, pa } = await world();
  const c = await app.inject({ method: "POST", url: `/gn/${ann.token}/api/pieces/${pa.id}/confirm` });
  assert.equal(c.json().ok, true);
  const e = await app.inject({ method: "POST", url: `/gn/${ann.token}/api/pieces/${pa.id}/edit`, payload: { title: "Hi", bodyHtml: "<p>x</p>", status: "dropped", contributorId: "z" } });
  assert.equal(e.json().ok, true);
  const p = (await getPiece(pool, pa.id))!;
  assert.equal(p.title, "Hi");
  assert.equal(p.status, "changed");
});

test("gn image rejects video", async () => {
  const { ann } = await world();
  const r = await app.inject({ method: "POST", url: `/gn/${ann.token}/api/image`, headers: { "content-type": "video/mp4" }, payload: Buffer.from("abc") });
  assert.equal(r.json().ok, false);
  const bad = await app.inject({ method: "POST", url: "/gn/nope/api/image", headers: { "content-type": "image/png" }, payload: Buffer.from("abc") });
  assert.equal(bad.statusCode, 404);
});

test("gn static allowlist", async () => {
  assert.equal((await app.inject({ url: "/gn/_/grmc.css" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/gn/_/contributor.js" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/gn/_/package.json" })).statusCode, 404);
  assert.equal((await app.inject({ url: "/gn/_/..%2f..%2fpackage.json" })).statusCode, 404);
});

test("admin sheet route", async () => {
  const { issue } = await world();
  const r = await app.inject({ url: `/api/gracenotes/issues/${issue.id}/sheet` });
  const body = r.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.blocks));
});

test("admin contributor list has links but no other route leaks tokens", async () => {
  const { ann, issue } = await world();
  const r = await app.inject({ url: "/api/gracenotes/contributors", headers: { host: "social.example.org" } });
  const list = r.json().contributors;
  assert.equal(list.find((c: { id: string }) => c.id === ann.id).link, `https://social.example.org/gn/${ann.token}`);
  const detail = await app.inject({ url: `/api/gracenotes/issues/${issue.id}` });
  assert.equal(detail.json().ok, true);
  assert.ok(!detail.body.includes(ann.token));
});

test("admin marks an issue sent through markIssueSent", async () => {
  const { issue } = await world();
  const r = await app.inject({ method: "POST", url: `/api/gracenotes/issues/${issue.id}/sent`, headers: { "x-auth-email": "a@x.org" } });
  assert.equal(r.json().ok, true);
  const { rows } = await pool.query("SELECT status, sheet_snapshot FROM gn_issues WHERE id = $1", [issue.id]).catch(() => ({ rows: [] as any[] }));
  assert.equal(rows[0]?.status, "sent");
});

test("admin can create contributors, sections and issues", async () => {
  const c = await app.inject({ method: "POST", url: "/api/gracenotes/contributors", payload: { name: "Cy", email: "cy@x.org" } });
  assert.equal(c.json().ok, true);
  const s = await app.inject({ method: "POST", url: "/api/gracenotes/sections", payload: { title: "News", kind: "text" } });
  assert.equal(s.json().ok, true);
  const o = await app.inject({ method: "PUT", url: `/api/gracenotes/sections/${s.json().section.id}/owners`, payload: { contributorIds: [c.json().contributor.id] } });
  assert.equal(o.json().ok, true);
  const i = await app.inject({ method: "POST", url: "/api/gracenotes/issues", payload: { issueDate: "2026-11-18" } });
  assert.equal(i.json().ok, true);
  const bad = await app.inject({ method: "POST", url: "/api/gracenotes/issues", payload: { issueDate: "nonsense" } });
  assert.equal(bad.json().ok, false);
});
