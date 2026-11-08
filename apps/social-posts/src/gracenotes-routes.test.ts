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
import { setSetting } from "./settings";

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

test("gn fonts are served from an allowlisted filename pattern", async () => {
  const ok = await app.inject({ url: "/gn/_/fonts/inter-400.woff2" });
  assert.equal(ok.statusCode, 200);
  assert.match(String(ok.headers["content-type"]), /font\/woff2/);
  for (const bad of ["..%2fgrmc.css", "..%2f..%2f..%2fpackage.json", "inter-400.css", "nope.woff2", ".woff2", "a%00.woff2"]) {
    assert.equal((await app.inject({ url: `/gn/_/fonts/${bad}` })).statusCode, 404, bad);
  }
});

test("gn picture links must be ours", async () => {
  const { ann, pa } = await world();
  const sa = val<{ id: string }>(await createSection(pool, { title: "Coming up", kind: "events" }));
  await setSetting(pool, "r2_public_base_url", "https://cdn.example.org/");
  const edit = (imageUrl: string) => app.inject({ method: "POST", url: `/gn/${ann.token}/api/pieces/${pa.id}/edit`, payload: { title: "T", imageUrl } });
  const add = (imageUrl: string) => app.inject({ method: "POST", url: `/gn/${ann.token}/api/sections/${sa.id}/items`, payload: { title: "N", imageUrl } });
  const WRONG = { ok: false, error: "Upload the picture here instead." };
  for (const bad of ["https://evil.example.com/x.png", "http://cdn.example.org/x.png", "https://cdn.example.org.evil.com/x.png", "javascript:alert(1)", "https://cdn.example.org/a b.png"]) {
    assert.deepEqual((await edit(bad)).json(), WRONG, bad);
    assert.deepEqual((await add(bad)).json(), WRONG, bad);
  }
  assert.equal((await edit("https://cdn.example.org/media/x.png")).json().ok, true);
  assert.equal((await getPiece(pool, pa.id))!.imageUrl, "https://cdn.example.org/media/x.png");
  assert.equal((await add("https://cdn.example.org/media/y.png")).json().ok, true);
  assert.equal((await edit("")).json().ok, true);
  assert.equal((await getPiece(pool, pa.id))!.imageUrl, "");
  await setSetting(pool, "r2_public_base_url", "");
  assert.deepEqual((await edit("https://cdn.example.org/media/x.png")).json(), WRONG);
});

test("gn image: dead token is refused before the body, big and wrong files get plain messages", async () => {
  const { ann } = await world();
  const big = Buffer.alloc(10_500_000, 1);
  const dead = await app.inject({ method: "POST", url: "/gn/nope/api/image", headers: { "content-type": "image/png" }, payload: big });
  assert.equal(dead.statusCode, 404);
  const tooBig = await app.inject({ method: "POST", url: `/gn/${ann.token}/api/image`, headers: { "content-type": "image/png" }, payload: big });
  assert.equal(tooBig.statusCode, 413);
  assert.deepEqual(tooBig.json(), { ok: false, error: "That picture is over 10 MB." });
  const WRONG = { ok: false, error: "Upload a photo (JPG, PNG, GIF or WebP)." };
  for (const type of ["video/mp4", "image/svg+xml", "image/tiff"]) {
    const r = await app.inject({ method: "POST", url: `/gn/${ann.token}/api/image`, headers: { "content-type": type }, payload: Buffer.from("abc") });
    assert.deepEqual(r.json(), WRONG, type);
  }
  const txt = await app.inject({ method: "POST", url: `/gn/${ann.token}/api/image`, headers: { "content-type": "text/plain" }, payload: "abc" });
  assert.deepEqual(txt.json(), WRONG);
});

test("gn unexpected failures on public routes say something plain and leak nothing", async () => {
  const broken = Fastify({ logger: false });
  const boom = { query: async () => { throw new Error("relation gn_secret does not exist"); } } as unknown as Pool;
  await broken.register(contributorRoutes, { db: boom });
  await broken.ready();
  for (const [method, url] of [["GET", "/gn/abc/api/view"], ["POST", "/gn/abc/api/pieces/1/confirm"], ["POST", "/gn/abc/api/image"], ["GET", "/gn/abc"]] as const) {
    const r = await broken.inject({ method, url, headers: method === "POST" ? { "content-type": "image/png" } : {}, payload: method === "POST" ? Buffer.from("abc") : undefined });
    assert.equal(r.statusCode, 500, url);
    assert.ok(!r.body.includes("gn_secret"), url);
    assert.equal(r.json().error, "Something went wrong. Try again in a minute.", url);
  }
  await broken.close();
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

test("gn page answers with or without a trailing slash", async () => {
  const { ann } = await world();
  const a = await app.inject({ url: `/gn/${ann.token}` });
  const b = await app.inject({ url: `/gn/${ann.token}/` });
  assert.equal(b.statusCode, 200);
  assert.equal(b.body, a.body);
  assert.equal((await app.inject({ url: "/gn/nope/" })).statusCode, 404);
});

test("gn view carries the deadline from the schedule", async () => {
  const { ann } = await world();
  try {
    await setSetting(pool, "gn_deadline_at", "12:00");
    assert.equal((await app.inject({ url: `/gn/${ann.token}/api/view` })).json().deadline, "Tue noon");
    await setSetting(pool, "gn_deadline_at", "15:00");
    assert.equal((await app.inject({ url: `/gn/${ann.token}/api/view` })).json().deadline, "Tue 3pm");
    await setSetting(pool, "gn_send_dow", "4");
    await setSetting(pool, "gn_deadline_at", "09:30");
    assert.equal((await app.inject({ url: `/gn/${ann.token}/api/view` })).json().deadline, "Wed 9:30am");
  } finally {
    await pool.query("DELETE FROM settings WHERE key = ANY($1)", [["gn_deadline_at", "gn_send_dow"]]);
  }
});

test("admin adds an existing event to an issue", async () => {
  const { issue } = await world();
  const items = val<{ id: string }>(await createSection(pool, { title: "Events", kind: "events" }));
  await pool.query("INSERT INTO events (id, name, start_date) VALUES ('gntest-r1', 'Bazaar', '2026-11-21')");
  const url = `/api/gracenotes/issues/${issue.id}/sections/${items.id}/items/from-event`;
  const r = await app.inject({ method: "POST", url, payload: { eventId: "gntest-r1" } });
  assert.equal(r.json().ok, true);
  assert.equal(r.json().piece.eventId, "gntest-r1");
  assert.deepEqual((await app.inject({ method: "POST", url, payload: { eventId: "gntest-r1" } })).json(),
    { ok: false, error: "That event is already in this issue." });
});

test("an issue started before its sections exist gets them, for Mitchell and for the owner", async () => {
  const james = await person("james");
  const issue = val<{ id: string }>(await createIssue(pool, "2026-11-11"));
  const add = await app.inject({ method: "POST", url: "/api/gracenotes/sections", payload: { title: "Pastor Message", kind: "text" } });
  const sec = add.json().section as { id: string };
  await setSectionOwners(pool, sec.id, [james.id]);
  const detail = (await app.inject({ url: `/api/gracenotes/issues/${issue.id}` })).json();
  assert.equal(detail.pieces.filter((p: { sectionId: string }) => p.sectionId === sec.id).length, 1);
  assert.equal(detail.contributors.find((c: { contributorId: string }) => c.contributorId === james.id).state, "outstanding");
  const view = (await app.inject({ url: `/gn/${james.token}/api/view` })).json();
  assert.equal(view.pieces.length, 1);
});

test("an issue whose pieces were never made is repaired when opened", async () => {
  const issue = val<{ id: string }>(await createIssue(pool, "2026-11-11"));
  // A section created straight in the database, the way the existing issue in production is missing them.
  const sec = val<{ id: string }>(await createSection(pool, { title: "Sunday Sermon", kind: "text" }));
  assert.equal((await listPieces(pool, issue.id)).length, 0);
  const detail = (await app.inject({ url: `/api/gracenotes/issues/${issue.id}` })).json();
  assert.equal(detail.pieces.filter((p: { sectionId: string }) => p.sectionId === sec.id).length, 1);
});
