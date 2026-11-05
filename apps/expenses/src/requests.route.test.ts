// Route-level tests: the real request, decision and receipt routes, driven with
// fastify.inject() against the test database. config is shared by reference
// and db.ts builds its pool on first import, so point it at TEST_DATABASE_URL
// before importing anything that touches the database.
import { strict as assert } from "node:assert";
import { test, after, beforeEach } from "node:test";
import { config } from "./config";

const url = process.env.TEST_DATABASE_URL;
if (url) config.databaseUrl = url;
const skip = !url;

let app: any = null, pool: any = null;
async function setup() {
  if (app) return;
  const db = await import("./db");
  pool = db.pool;
  await db.ensureSchema();
  const Fastify = (await import("fastify")).default;
  app = Fastify();
  await app.register((await import("@fastify/multipart")).default, {
    limits: { fileSize: 1024 * 1024, files: 10 },
  });
  await app.register((await import("./routes/requests")).requestRoutes);
  await app.register((await import("./routes/decisions")).decisionRoutes);
  await app.register((await import("./routes/receipts")).receiptRoutes);
  await app.register((await import("./routes/reports")).reportRoutes);
}
after(async () => { if (app) await app.close(); if (pool) await pool.end(); });

const as = (email: string, name: string) => ({ "x-auth-email": email, "x-auth-name": name });
const OFFICE = as("office@x.org", "Olive Office");
const PASTOR = as("pastor@x.org", "Pat Pastor");
const ANN = as("ann@x.org", "Ann Member");
let annCard = 0;

beforeEach(async () => {
  if (skip) return;
  await setup();
  await pool.query("TRUNCATE requests, cards, card_users, app_users, notifications RESTART IDENTITY CASCADE");
  await pool.query(
    `INSERT INTO app_users (email, name, can_submit, can_submit_for_others, can_approve, can_manage, can_pay, can_audit, is_admin) VALUES
     ('office@x.org', 'Olive Office', true,  true,  true,  true,  true,  false, true),
     ('pastor@x.org', 'Pat Pastor',   true,  false, true,  false, false, false, false),
     ('ann@x.org',    'Ann Member',   true,  false, false, false, false, false, false),
     ('bob@x.org',    'Bob Member',   true,  false, false, false, false, false, false),
     ('cpa@x.org',    'Cora CPA',     false, false, false, false, false, true,  false)`
  );
  annCard = (await pool.query(
    "INSERT INTO cards (last4, nickname, primary_email) VALUES ('1234', 'Ministry', 'ann@x.org') RETURNING id::int AS id"
  )).rows[0].id;
  await pool.query("UPDATE settings SET value = 'false' WHERE key = 'allow_self_approval'");
  await pool.query("DELETE FROM settings WHERE key IN ('resend_api_key', 'mail_from')");
});

const today = new Date().toISOString().slice(0, 10);
function body(over: Record<string, unknown> = {}) {
  return {
    kind: "post_purchase", paymentMethod: "church_card", requestDate: today,
    amount: 100, reason: "VBS crafts", vendor: "Hobby Lobby", cardId: annCard,
    approverEmail: "pastor@x.org", items: [], ...over,
  };
}
async function submit(headers = ANN, over: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/api/requests", headers, payload: body(over) });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).id as number;
}
async function detail(id: number, headers = ANN) {
  return JSON.parse((await app.inject({ url: `/api/requests/${id}`, headers })).body);
}
async function decide(id: number, action: string, headers = PASTOR, comment = "") {
  const { request } = await detail(id, headers);
  return app.inject({
    method: "POST", url: `/api/requests/${id}/decision`, headers,
    payload: { action, comment, version: request.version },
  });
}

test("changes requested → edited → sent back → in the approver's queue → approved", { skip }, async () => {
  const id = await submit();
  assert.equal((await decide(id, "request_changes", PASTOR, "Which event?")).statusCode, 200);

  const queueBefore = JSON.parse((await app.inject({ url: "/api/queue", headers: PASTOR })).body);
  assert.equal(queueBefore.count, 0);

  const d = await detail(id);
  assert.equal(d.allowed.resubmit, true);
  const patched = await app.inject({
    method: "PATCH", url: `/api/requests/${id}`, headers: ANN,
    payload: { reason: "VBS crafts for the Sunday event", version: d.request.version },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const resent = await app.inject({
    method: "POST", url: `/api/requests/${id}/resubmit`, headers: ANN,
    payload: { comment: "For Sunday", version: JSON.parse(patched.body).version },
  });
  assert.equal(resent.statusCode, 200, resent.body);

  const queue = JSON.parse((await app.inject({ url: "/api/queue", headers: PASTOR })).body);
  assert.deepEqual(queue.requests.map((r: any) => r.id), [id]);
  assert.equal((await decide(id, "approve")).statusCode, 200);
  const events = (await detail(id)).events.map((e: any) => e.type);
  assert.deepEqual(events, ["submitted", "changes_requested", "edited", "resubmitted", "approved"]);
});

test("an approver on a stale page cannot approve numbers they never saw", { skip }, async () => {
  const id = await submit();
  const seen = (await detail(id, PASTOR)).request.version;
  await app.inject({ method: "PATCH", url: `/api/requests/${id}`, headers: ANN, payload: { amount: 5000 } });

  const res = await app.inject({
    method: "POST", url: `/api/requests/${id}/decision`, headers: PASTOR,
    payload: { action: "approve", version: seen },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).stale, true);
  assert.equal((await detail(id)).request.status, "pending");

  const noVersion = await app.inject({
    method: "POST", url: `/api/requests/${id}/decision`, headers: PASTOR, payload: { action: "approve" },
  });
  assert.equal(noVersion.statusCode, 409);
});

test("the office cannot route the pastor's own purchase to the pastor", { skip }, async () => {
  await pool.query(
    "INSERT INTO cards (last4, nickname, primary_email) VALUES ('9999', 'Pastor', 'pastor@x.org')"
  );
  const pastorCard = (await pool.query("SELECT id::int AS id FROM cards WHERE last4 = '9999'")).rows[0].id;
  const refused = await app.inject({
    method: "POST", url: "/api/requests", headers: OFFICE,
    payload: body({ purchasedBy: "Pat Pastor", purchasedByEmail: "pastor@x.org", cardId: pastorCard }),
  });
  assert.equal(refused.statusCode, 400);
  assert.match(JSON.parse(refused.body).error, /bought it/);

  // Keyed with someone else as approver, then reassigned in the database the
  // way an old row might be: the decision itself still refuses.
  const id = await submit(OFFICE, {
    purchasedBy: "Pat Pastor", purchasedByEmail: "pastor@x.org", cardId: pastorCard, approverEmail: "office@x.org",
  }).catch(() => 0);
  assert.equal(id, 0, "the office cannot approve what it keyed either");
  const row = (await pool.query(
    `INSERT INTO requests (amount, reason, submitted_by_email, purchased_by_email, approver_email, status, request_date)
     VALUES (100, 'x', 'office@x.org', 'pastor@x.org', 'pastor@x.org', 'pending', now()) RETURNING id::int AS id`
  )).rows[0].id;
  const res = await decide(row, "approve");
  assert.equal(res.statusCode, 403);
});

test("the purchaser can finish a request the office keyed for them", { skip }, async () => {
  const id = await submit(OFFICE, {
    purchasedBy: "Ann Member", purchasedByEmail: "ann@x.org",
    kind: "pre_purchase", estimatedAmount: 200, amount: 0,
  });
  assert.equal((await decide(id, "approve")).statusCode, 200);
  const res = await app.inject({
    method: "POST", url: `/api/requests/${id}/actuals`, headers: ANN, payload: { amount: 190 },
  });
  assert.equal(res.statusCode, 200, res.body);
  const again = await app.inject({
    method: "POST", url: `/api/requests/${id}/actuals`, headers: ANN, payload: { amount: 210 },
  });
  assert.equal(again.statusCode, 409, "actuals are recorded once");
});

test("small corrections cannot walk an approved total past the tolerance", { skip }, async () => {
  const id = await submit();
  await decide(id, "approve");
  const edit = (amount: number) => app.inject({
    method: "PATCH", url: `/api/requests/${id}`, headers: OFFICE, payload: { amount },
  });
  assert.equal(JSON.parse((await edit(120)).body).reapprovalRequired, false);
  assert.equal(JSON.parse((await edit(140)).body).reapprovalRequired, true);
  const r = (await detail(id)).request;
  assert.equal(r.status, "pending");
  assert.equal(r.approval_method, null, "a returned request no longer claims an approval");
});

test("money that has been spent cannot be withdrawn or deleted", { skip }, async () => {
  const id = await submit();
  await decide(id, "approve");
  const mine = await app.inject({ method: "DELETE", url: `/api/requests/${id}`, headers: ANN });
  assert.equal(mine.statusCode, 409);
  const office = await app.inject({ method: "DELETE", url: `/api/requests/${id}`, headers: OFFICE });
  assert.equal(office.statusCode, 409);
  const voided = await app.inject({
    method: "POST", url: `/api/requests/${id}/void`, headers: OFFICE, payload: { reason: "Duplicate of #3" },
  });
  assert.equal(voided.statusCode, 200);
  assert.equal((await detail(id)).request.stage, "Voided");
});

test("a reimbursement is paid once, by someone else, on a real date", { skip }, async () => {
  const id = await submit(OFFICE, { paymentMethod: "reimbursement", cardId: null });
  await decide(id, "approve");
  const self = await app.inject({
    method: "POST", url: `/api/requests/${id}/reimburse`, headers: OFFICE, payload: { paidOn: today },
  });
  assert.equal(self.statusCode, 403);
  await pool.query("UPDATE app_users SET can_pay = true WHERE email = 'pastor@x.org'");
  const badDate = await app.inject({
    method: "POST", url: `/api/requests/${id}/reimburse`, headers: PASTOR, payload: { paidOn: "11/5" },
  });
  assert.equal(badDate.statusCode, 400);
  const paid = await app.inject({
    method: "POST", url: `/api/requests/${id}/reimburse`, headers: PASTOR, payload: { paidOn: today, reference: "Chk 1182" },
  });
  assert.equal(paid.statusCode, 200);
  const twice = await app.inject({
    method: "POST", url: `/api/requests/${id}/reimburse`, headers: PASTOR, payload: { paidOn: today },
  });
  assert.equal(twice.statusCode, 409);
});

async function multipart(files: { name: string; type: string; bytes: number }[]) {
  const fd = new FormData();
  for (const f of files) fd.append("files", new Blob([Buffer.alloc(f.bytes, 1)], { type: f.type }), f.name);
  const res = new Response(fd);
  return {
    headers: { "content-type": res.headers.get("content-type")! },
    payload: Buffer.from(await res.arrayBuffer()),
  };
}

test("a receipt upload that fails part-way stores nothing", { skip }, async () => {
  const id = await submit();
  const tooMany = await multipart(Array.from({ length: 11 }, (_, i) => ({ name: `r${i}.pdf`, type: "application/pdf", bytes: 10 })));
  const res = await app.inject({
    method: "POST", url: `/api/requests/${id}/receipts`,
    headers: { ...ANN, ...tooMany.headers }, payload: tooMany.payload,
  });
  assert.equal(res.statusCode, 413);
  const n = (await pool.query("SELECT count(*)::int AS n FROM receipts WHERE request_id = $1", [id])).rows[0].n;
  assert.equal(n, 0);
});

test("receipts upload with their events, and a unicode name still opens", { skip }, async () => {
  const id = await submit();
  const name = "Screenshot 2026-11-05 at 9.41.12 AM.png";
  const up = await multipart([
    { name, type: "image/png", bytes: 20 },
    { name: "notes.docx", type: "application/msword", bytes: 5 },
  ]);
  const res = await app.inject({
    method: "POST", url: `/api/requests/${id}/receipts`, headers: { ...ANN, ...up.headers }, payload: up.payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(JSON.parse(res.body), { ok: true, added: [name], rejected: ["notes.docx"] });

  const d = await detail(id);
  const ev = d.events.find((e: any) => e.type === "receipt_added");
  assert.equal(ev.comment, name);
  assert.match(ev.meta.sha256, /^[0-9a-f]{64}$/);
  const view = await app.inject({ url: `/api/requests/${id}/receipts/${d.receipts[0].id}`, headers: ANN });
  assert.equal(view.statusCode, 200);
});

test("validation refuses an empty, $0 or self-approved submission in plain words", { skip }, async () => {
  const bad = async (over: Record<string, unknown>, headers = ANN) =>
    JSON.parse((await app.inject({ method: "POST", url: "/api/requests", headers, payload: body(over) })).body).error;
  assert.match(await bad({ amount: 0 }), /amount/);
  assert.match(await bad({ reason: "" }), /what this was for/);
  assert.match(await bad({ approverEmail: "pastor@x.org" }, PASTOR), /yourself/);
  assert.match(await bad({ amount: "abc" }), /amount/);
  assert.match(await bad({ items: [{ title: "Glue", price: 40 }] }), /line items/);
});

test("people with no Expenses access cannot read requests, and bad ids are a 400", { skip }, async () => {
  const stranger = as("stranger@x.org", "S");
  assert.equal((await app.inject({ url: "/api/requests", headers: stranger })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/requests/abc", headers: ANN })).statusCode, 400);
});

const BOB = as("bob@x.org", "Bob Member");
const CPA = as("cpa@x.org", "Cora CPA");

test("a member sees only their own requests; someone else's is not found", { skip }, async () => {
  const annId = await submit();
  const bobId = await submit(BOB, { paymentMethod: "reimbursement", cardId: null });

  const list = async (h: Record<string, string>) =>
    JSON.parse((await app.inject({ url: "/api/requests", headers: h })).body).requests.map((r: any) => r.id);
  assert.deepEqual(await list(ANN), [annId]);
  assert.deepEqual(await list(BOB), [bobId]);
  assert.deepEqual((await list(PASTOR)).sort(), [annId, bobId]); // assigned to both
  assert.deepEqual((await list(CPA)).sort(), [annId, bobId]);

  assert.equal((await app.inject({ url: `/api/requests/${annId}`, headers: BOB })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/requests/${annId}/receipts`, headers: BOB })).statusCode, 404);
  const c = await app.inject({ method: "POST", url: `/api/requests/${annId}/comments`, headers: BOB, payload: { comment: "hi" } });
  assert.equal(c.statusCode, 404);
});

test("the accountant reads everything and reports, but cannot change a thing", { skip }, async () => {
  const id = await submit();
  const d = await detail(id, CPA);
  assert.equal(d.request.id, id);
  assert.equal((await app.inject({ url: "/api/reports/by-code", headers: CPA })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/export.csv", headers: CPA })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/reports/by-code", headers: ANN })).statusCode, 403);

  const v = d.request.version;
  const tries = [
    { method: "PATCH", url: `/api/requests/${id}`, payload: { reason: "x", version: v } },
    { method: "POST", url: `/api/requests/${id}/decision`, payload: { action: "approve", version: v } },
    { method: "POST", url: `/api/requests/${id}/paper-approval`, payload: { approvedOn: today, version: v } },
    { method: "POST", url: `/api/requests/${id}/void`, payload: { reason: "x", version: v } },
    { method: "DELETE", url: `/api/requests/${id}`, payload: { version: v } },
    { method: "POST", url: "/api/requests", payload: body() },
  ] as const;
  for (const t of tries) {
    const res = await app.inject({ ...t, headers: CPA });
    assert.equal(res.statusCode, 403, `${t.method} ${t.url}: ${res.body}`);
  }
});

test("the office records a paper approval in the approver's name, and cannot approve digitally", { skip }, async () => {
  await pool.query("UPDATE app_users SET can_approve = false WHERE email = 'office@x.org'");
  const id = await submit();
  const d = await detail(id, OFFICE);
  assert.equal(d.allowed.decide, false);
  assert.equal(d.allowed.paperApprove, true);
  assert.equal((await decide(id, "approve", OFFICE)).statusCode, 403);

  const res = await app.inject({
    method: "POST", url: `/api/requests/${id}/paper-approval`, headers: OFFICE,
    payload: { approvedOn: today, version: d.request.version },
  });
  assert.equal(res.statusCode, 200, res.body);
  const after = await detail(id);
  assert.equal(after.request.approved_by_email, "pastor@x.org");
  const ev = after.events.find((e: any) => e.type === "approved_on_paper");
  assert.equal(ev.actor_email, "office@x.org");
});

async function mailOn() {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('resend_api_key', 're_test'), ('mail_from', 'Expenses <x@x.org>')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  );
}
const outbox = async () =>
  (await pool.query("SELECT to_email, kind, status, attempts FROM notifications ORDER BY id")).rows;

test("with mail off nothing is queued; with it on, the approver is told in the same transaction", { skip }, async () => {
  await submit();
  assert.deepEqual(await outbox(), []);
  await mailOn();
  const id = await submit();
  assert.deepEqual((await outbox()).map((n: any) => [n.to_email, n.kind]), [["pastor@x.org", "submitted"]]);
  // A refused action queues nothing.
  await app.inject({ method: "POST", url: `/api/requests/${id}/decision`, headers: PASTOR,
                     payload: { action: "approve", version: 999 } });
  assert.equal((await outbox()).length, 1);
});

test("the sender marks mail sent, retries a failure, and gives up after five tries", { skip }, async () => {
  const { deliverPending } = await import("./mailer");
  await mailOn();
  await submit();
  await submit();

  const calls: any[] = [];
  const ok: any = async (_url: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  assert.equal(await deliverPending(pool, ok, 1), 1);
  assert.equal(calls[0].to[0], "pastor@x.org");
  assert.deepEqual((await outbox()).map((n: any) => n.status), ["sent", "pending"]);

  const down: any = async () => new Response("boom", { status: 500 });
  for (let i = 0; i < 5; i++) {
    await pool.query("UPDATE notifications SET next_attempt_at = now() WHERE status = 'pending'");
    assert.equal(await deliverPending(pool, down), 0);
  }
  const last = (await outbox())[1];
  assert.equal(last.status, "failed");
  assert.equal(last.attempts, 5);
});
