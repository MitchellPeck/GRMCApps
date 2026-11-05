import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NotifyContext, NotifyRequest, notificationsFor } from "./notify";

function req(over: Partial<NotifyRequest> = {}): NotifyRequest {
  return {
    id: 42, kind: "post_purchase", payment_method: "church_card", status: "pending",
    submitted_by_email: "ann@x.org", purchased_by_email: "", approver_email: "pastor@x.org",
    amount: 120, estimated_amount: null, approved_at: null, approved_amount: null,
    actuals_completed_at: null, reimbursed_at: null, voided_at: null, version: 1,
    vendor: "Hobby Lobby", reason: "VBS crafts", submitted_by: "Ann Member",
    ...over,
  };
}

function ctx(over: Partial<NotifyContext> = {}): NotifyContext {
  return {
    actorEmail: "ann@x.org", actorName: "Ann Member", comment: "", meta: null,
    payers: ["office@x.org"], appUrl: "https://expenses.grmc.app", orgName: "GRMC",
    ...over,
  };
}

const to = (drafts: { to: string }[]) => drafts.map((d) => d.to).sort();

test("a new request goes to its approver, with a link straight to it", () => {
  const out = notificationsFor("submitted", req(), ctx());
  assert.deepEqual(to(out), ["pastor@x.org"]);
  assert.match(out[0].subject, /\$120\.00/);
  assert.match(out[0].body, /https:\/\/expenses\.grmc\.app\/#\/r\/42/);
  assert.match(out[0].body, /Ann Member/);
});

test("nobody is emailed about what they did themselves", () => {
  // Ann approving her own request (self-approval allowed) mails nobody.
  const r = req({ approver_email: "ann@x.org", status: "approved" });
  assert.deepEqual(notificationsFor("approved", r, ctx()), []);
});

test("a decision goes to both owners, with the approver's words", () => {
  const r = req({ purchased_by_email: "bob@x.org", status: "changes_requested" });
  const out = notificationsFor("changes_requested", r,
    ctx({ actorEmail: "pastor@x.org", actorName: "Pat", comment: "Which event?" }));
  assert.deepEqual(to(out), ["ann@x.org", "bob@x.org"]);
  assert.match(out[0].body, /"Which event\?"/);
  assert.match(out[0].body, /Send back to approver/);
});

test("an approved reimbursement tells the payer it is ready, but not if the payer is the payee", () => {
  const r = req({ status: "approved", payment_method: "reimbursement", approved_amount: 120 });
  const out = notificationsFor("approved", r, ctx({ actorEmail: "pastor@x.org" }));
  assert.deepEqual(out.map((d) => [d.to, d.kind]).sort(),
    [["ann@x.org", "approved"], ["office@x.org", "ready_to_pay"]]);

  const own = notificationsFor("approved", r, ctx({ actorEmail: "pastor@x.org", payers: ["ann@x.org"] }));
  assert.deepEqual(own.map((d) => d.kind), ["approved"]);
});

test("an approved pre-purchase tells the buyer what to do next and does not ask anyone to pay yet", () => {
  const r = req({ kind: "pre_purchase", payment_method: "reimbursement", status: "approved", estimated_amount: 300 });
  const out = notificationsFor("approved", r, ctx({ actorEmail: "pastor@x.org" }));
  assert.deepEqual(to(out), ["ann@x.org"]);
  assert.match(out[0].body, /record what it actually cost/);
});

test("actuals in on a reimbursement → ready to pay; a return for re-approval → the approver", () => {
  const done = req({ kind: "pre_purchase", payment_method: "reimbursement", status: "approved",
                     actuals_completed_at: "2026-11-05" });
  assert.deepEqual(to(notificationsFor("actuals_completed", done, ctx())), ["office@x.org"]);

  const back = req({ kind: "pre_purchase", status: "pending", approved_amount: 100, amount: 180 });
  const out = notificationsFor("reapproval_required", back, ctx());
  assert.deepEqual(to(out), ["pastor@x.org"]);
  assert.match(out[0].body, /\$100\.00.*\$180\.00/s);
});

test("payment goes to whoever bought it, with the date and reference", () => {
  const r = req({ purchased_by_email: "bob@x.org", payment_method: "reimbursement", status: "approved",
                  reimbursed_at: "2026-11-05" });
  const out = notificationsFor("reimbursed", r,
    ctx({ actorEmail: "office@x.org", comment: "Chk 1182", meta: { paidOn: "2026-11-05" } }));
  assert.deepEqual(to(out), ["bob@x.org"]);
  assert.match(out[0].body, /on 2026-11-05 \(Chk 1182\)/);
});

test("a comment reaches the owners and the approver, deduplicated and lower-cased", () => {
  const r = req({ purchased_by_email: "Pastor@X.org" });
  const out = notificationsFor("comment", r, ctx({ actorEmail: "office@x.org", comment: "Receipt?" }));
  assert.deepEqual(to(out), ["ann@x.org", "pastor@x.org"]);
});

test("quiet events send nothing, and no app URL means no link line", () => {
  assert.deepEqual(notificationsFor("receipt_added", req(), ctx()), []);
  assert.deepEqual(notificationsFor("edited", req(), ctx()), []);
  const out = notificationsFor("submitted", req(), ctx({ appUrl: "" }));
  assert.doesNotMatch(out[0].body, /Open it/);
});
