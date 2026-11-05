import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ExpenseRequest,
  allowedActions,
  canSee,
  checkActuals,
  checkAddReceipts,
  checkDecision,
  checkDelete,
  checkEdit,
  checkPaperApproval,
  checkReimburse,
  checkResubmit,
  checkVoid,
  describeEdit,
  needsReapproval,
  reapprovalAfterEdit,
  requiredFields,
  stageOf,
  statusAfterDecision,
} from "./lifecycle";
import { NO_PERMISSIONS, Permissions } from "./permissions";

function req(over: Partial<ExpenseRequest> = {}): ExpenseRequest {
  return {
    id: 1,
    kind: "post_purchase",
    payment_method: "church_card",
    status: "pending",
    submitted_by_email: "a@grmc.app",
    purchased_by_email: "",
    approver_email: "b@grmc.app",
    amount: 100,
    estimated_amount: null,
    approved_at: null,
    actuals_completed_at: null,
    reimbursed_at: null,
    approved_amount: null,
    voided_at: null,
    version: 0,
    ...over,
  };
}

// ── stageOf ───────────────────────────────────────────────────────────────

test("pending, changes requested and rejected read straight off status", () => {
  assert.equal(stageOf(req()), "Awaiting approval");
  assert.equal(stageOf(req({ status: "changes_requested" })), "Changes requested");
  assert.equal(stageOf(req({ status: "rejected" })), "Rejected");
});

test("an approved pre-purchase still needs its receipts", () => {
  const r = req({ kind: "pre_purchase", status: "approved", approved_at: "2026-09-17T00:00:00Z" });
  assert.equal(stageOf(r), "Approved — awaiting receipts");
});

test("once actuals are in, a church-card pre-purchase is complete", () => {
  const r = req({
    kind: "pre_purchase", status: "approved",
    approved_at: "2026-09-17T00:00:00Z", actuals_completed_at: "2026-09-18T00:00:00Z",
  });
  assert.equal(stageOf(r), "Complete");
});

test("an approved reimbursement waits on payment", () => {
  const r = req({ payment_method: "reimbursement", status: "approved", approved_at: "2026-09-17T00:00:00Z" });
  assert.equal(stageOf(r), "Approved — awaiting reimbursement");
});

test("a paid reimbursement is complete", () => {
  const r = req({
    payment_method: "reimbursement", status: "approved",
    approved_at: "2026-09-17T00:00:00Z", reimbursed_at: "2026-09-20T00:00:00Z",
  });
  assert.equal(stageOf(r), "Complete");
});

test("receipts come before payment for a pre-purchase reimbursement", () => {
  // Both milestones are outstanding; receipts are the actionable next step, and
  // a reimbursement should not be paid before its actual amount is known.
  const r = req({
    kind: "pre_purchase", payment_method: "reimbursement",
    status: "approved", approved_at: "2026-09-17T00:00:00Z",
  });
  assert.equal(stageOf(r), "Approved — awaiting receipts");
});

test("an approved post-purchase church-card expense is done", () => {
  assert.equal(stageOf(req({ status: "approved", approved_at: "2026-09-17T00:00:00Z" })), "Complete");
});

// ── requiredFields ────────────────────────────────────────────────────────

test("required fields follow the two dimensions independently", () => {
  assert.deepEqual(requiredFields("post_purchase", "church_card"), {
    card: true, receipts: true, estimate: false,
  });
  assert.deepEqual(requiredFields("post_purchase", "reimbursement"), {
    card: false, receipts: true, estimate: false,
  });
  assert.deepEqual(requiredFields("pre_purchase", "church_card"), {
    card: true, receipts: false, estimate: true,
  });
  assert.deepEqual(requiredFields("pre_purchase", "reimbursement"), {
    card: false, receipts: false, estimate: true,
  });
});

// ── checkDecision / checkEdit ─────────────────────────────────────────────

const approver: Permissions = { ...NO_PERMISSIONS, approve: true };
const manager: Permissions = { ...NO_PERMISSIONS, approve: true, manage: true, pay: true };
const assistant: Permissions = { ...NO_PERMISSIONS, submit: true, submitForOthers: true, manage: true, pay: true };
const accountant: Permissions = { ...NO_PERMISSIONS, audit: true };
const submitter: Permissions = NO_PERMISSIONS;

test("the assigned approver may decide", () => {
  assert.deepEqual(checkDecision(req(), "b@grmc.app", approver, "approve", "", false), { ok: true });
});

test("an approver who is not assigned may not", () => {
  assert.equal(checkDecision(req(), "c@grmc.app", approver, "approve", "", false).ok, false);
});

test("manage may decide anyone's request", () => {
  assert.deepEqual(checkDecision(req(), "c@grmc.app", manager, "approve", "", false), { ok: true });
});

test("self-approval is refused, manage included", () => {
  const r = req({ submitted_by_email: "c@grmc.app", approver_email: "c@grmc.app" });
  const out = checkDecision(r, "c@grmc.app", manager, "approve", "", false);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /own request/i);
});

test("self-approval is allowed when the setting is on", () => {
  const r = req({ submitted_by_email: "c@grmc.app", approver_email: "c@grmc.app" });
  assert.deepEqual(checkDecision(r, "c@grmc.app", manager, "approve", "", true), { ok: true });
});

test("a decided request cannot be decided again", () => {
  const out = checkDecision(req({ status: "approved" }), "b@grmc.app", approver, "approve", "", false);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /no longer awaiting/i);
});

test("the purchaser cannot approve a request the office keyed for them", () => {
  const r = req({ submitted_by_email: "office@grmc.app", purchased_by_email: "b@grmc.app" });
  const out = checkDecision(r, "b@grmc.app", approver, "approve", "", false);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /own request/i);
});

test("rejecting requires a comment", () => {
  assert.equal(checkDecision(req(), "b@grmc.app", approver, "reject", "", false).ok, false);
  assert.deepEqual(checkDecision(req(), "b@grmc.app", approver, "reject", "Not in budget", false), { ok: true });
});

test("requesting changes requires a comment", () => {
  assert.equal(
    checkDecision(req(), "b@grmc.app", approver, "request_changes", "   ", false).ok,
    false
  );
});

test("someone with no approve permission is refused", () => {
  assert.equal(checkDecision(req(), "b@grmc.app", NO_PERMISSIONS, "approve", "", false).ok, false);
});

test("statusAfterDecision maps the three actions", () => {
  assert.equal(statusAfterDecision("approve"), "approved");
  assert.equal(statusAfterDecision("reject"), "rejected");
  assert.equal(statusAfterDecision("request_changes"), "changes_requested");
});

test("the submitter may edit their own pending request without any permission", () => {
  // editOwn is gone: submitting a request carries the right to revise it.
  assert.deepEqual(checkEdit(req(), "a@grmc.app", submitter), { ok: true });
});

test("editing a changes-requested request is allowed \u2014 that is the point of it", () => {
  assert.deepEqual(checkEdit(req({ status: "changes_requested" }), "a@grmc.app", submitter), { ok: true });
});

test("the submitter loses the edit once a decision is on record", () => {
  for (const status of ["approved", "rejected", "withdrawn"] as const) {
    const out = checkEdit(req({ status }), "a@grmc.app", submitter);
    assert.equal(out.ok, false, `expected ${status} to be locked to the submitter`);
    assert.equal((out as { status: number }).status, 409);
  }
});

test("editing someone else's request needs manage", () => {
  assert.equal(checkEdit(req(), "z@grmc.app", submitter).ok, false);
  assert.deepEqual(checkEdit(req(), "z@grmc.app", manager), { ok: true });
});

test("manage may correct an approved request \u2014 the charge came in different", () => {
  assert.deepEqual(checkEdit(req({ status: "approved" }), "z@grmc.app", manager), { ok: true });
});

test("nobody edits a paid reimbursement", () => {
  const out = checkEdit(req({ status: "approved", reimbursed_at: "2026-11-01" }), "z@grmc.app", manager);
  assert.equal(out.ok, false);
});

test("the purchaser may edit a request the office keyed for them", () => {
  const r = req({ submitted_by_email: "office@grmc.app", purchased_by_email: "a@grmc.app" });
  assert.deepEqual(checkEdit(r, "a@grmc.app", submitter), { ok: true });
});

test("not even manage edits a dead record", () => {
  for (const status of ["rejected", "withdrawn", "voided"] as const) {
    const out = checkEdit(req({ status }), "z@grmc.app", manager);
    assert.equal(out.ok, false, `expected manage to be refused on ${status}`);
    assert.equal((out as { status: number }).status, 409);
  }
});

// ── checkDelete ─────────────────────────────────────────────────────────────

test("a submitter deletes their own undecided request outright", () => {
  for (const status of ["pending", "changes_requested"] as const) {
    assert.deepEqual(checkDelete(req({ status }), "a@grmc.app", submitter), { ok: true, mode: "hard" });
  }
});

test("an approved pre-purchase not yet bought is withdrawn, not deleted", () => {
  const r = req({ status: "approved", kind: "pre_purchase", approved_amount: 100 });
  assert.deepEqual(checkDelete(r, "a@grmc.app", submitter), { ok: true, mode: "withdraw" });
});

test("money already spent cannot be withdrawn", () => {
  const cases = [
    req({ status: "approved", approved_amount: 100 }),
    req({ status: "approved", kind: "pre_purchase", approved_amount: 100, actuals_completed_at: "2026-11-01" }),
    req({ status: "approved", payment_method: "reimbursement", approved_amount: 100, reimbursed_at: "2026-11-01" }),
  ];
  for (const r of cases) {
    const out = checkDelete(r, "a@grmc.app", submitter);
    assert.equal(out.ok, false);
    assert.match((out as { error: string }).error, /already been spent/);
  }
});

test("a request that was ever approved is never hard-deleted, even back in pending", () => {
  const r = req({ status: "pending", approved_amount: 100 });
  assert.equal(checkDelete(r, "a@grmc.app", submitter).ok, false);
  assert.equal(checkDelete(r, "z@grmc.app", manager).ok, false);
});

test("manage hard-deletes only undecided requests, and is pointed at Void otherwise", () => {
  assert.deepEqual(checkDelete(req(), "z@grmc.app", manager), { ok: true, mode: "hard" });
  const out = checkDelete(req({ status: "approved", approved_amount: 100 }), "z@grmc.app", manager);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /Void/);
});

test("a rejected request is a dead record, not a withdrawal", () => {
  assert.equal(checkDelete(req({ status: "rejected" }), "a@grmc.app", submitter).ok, false);
});

test("the purchaser counts as an owner for deleting", () => {
  const r = req({ submitted_by_email: "office@grmc.app", purchased_by_email: "a@grmc.app" });
  assert.deepEqual(checkDelete(r, "a@grmc.app", submitter), { ok: true, mode: "hard" });
});

test("a bystander may not delete someone else's request", () => {
  const out = checkDelete(req(), "z@grmc.app", submitter);
  assert.equal(out.ok, false);
  assert.equal((out as { status: number }).status, 403);
});

// ── checkVoid ───────────────────────────────────────────────────────────────

test("manage voids a decided request with a reason", () => {
  assert.deepEqual(checkVoid(req({ status: "approved" }), manager, "Duplicate of #12"), { ok: true });
});

test("voiding needs a reason, manage, and an unpaid live request", () => {
  assert.equal(checkVoid(req({ status: "approved" }), manager, "  ").ok, false);
  assert.equal(checkVoid(req({ status: "approved" }), approver, "dup").ok, false);
  assert.equal(checkVoid(req({ status: "voided" }), manager, "dup").ok, false);
  assert.equal(checkVoid(req({ status: "approved", reimbursed_at: "2026-11-01" }), manager, "dup").ok, false);
});

// ── checkResubmit ───────────────────────────────────────────────────────────

test("the owner sends a changes-requested request back", () => {
  assert.deepEqual(checkResubmit(req({ status: "changes_requested" }), "a@grmc.app", submitter), { ok: true });
  const keyed = req({ status: "changes_requested", submitted_by_email: "office@grmc.app", purchased_by_email: "a@grmc.app" });
  assert.deepEqual(checkResubmit(keyed, "a@grmc.app", submitter), { ok: true });
  assert.deepEqual(checkResubmit(req({ status: "changes_requested" }), "z@grmc.app", manager), { ok: true });
});

test("only changes-requested can be resubmitted, and only by its owner or manage", () => {
  assert.equal(checkResubmit(req({ status: "pending" }), "a@grmc.app", submitter).ok, false);
  assert.equal(checkResubmit(req({ status: "changes_requested" }), "z@grmc.app", submitter).ok, false);
});

// ── checkActuals / checkReimburse / checkAddReceipts ────────────────────────

const approvedPre = req({ status: "approved", kind: "pre_purchase", estimated_amount: 100, approved_amount: 100, amount: 0 });

test("actuals are recorded once", () => {
  assert.deepEqual(checkActuals(approvedPre, "a@grmc.app", submitter), { ok: true });
  const done = { ...approvedPre, actuals_completed_at: "2026-11-01" };
  assert.equal(checkActuals(done, "a@grmc.app", submitter).ok, false);
});

test("the purchaser records actuals on a request keyed by the office", () => {
  const r = { ...approvedPre, submitted_by_email: "office@grmc.app", purchased_by_email: "a@grmc.app" };
  assert.deepEqual(checkActuals(r, "a@grmc.app", submitter), { ok: true });
});

const owed = req({ status: "approved", payment_method: "reimbursement", approved_amount: 100 });

test("manage pays an approved reimbursement once", () => {
  assert.deepEqual(checkReimburse(owed, "z@grmc.app", manager), { ok: true });
  assert.equal(checkReimburse({ ...owed, reimbursed_at: "2026-11-01" }, "z@grmc.app", manager).ok, false);
});

test("nobody records paying themselves", () => {
  const out = checkReimburse(owed, "a@grmc.app", manager);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /Someone else/);
  const keyed = { ...owed, submitted_by_email: "office@grmc.app", purchased_by_email: "p@grmc.app" };
  assert.equal(checkReimburse(keyed, "p@grmc.app", manager).ok, false);
});

test("receipts can be added by owners until the request is dead", () => {
  assert.deepEqual(checkAddReceipts(req({ status: "approved" }), "a@grmc.app", submitter), { ok: true });
  for (const status of ["rejected", "withdrawn", "voided"] as const) {
    assert.equal(checkAddReceipts(req({ status }), "a@grmc.app", submitter).ok, false);
  }
  assert.equal(checkAddReceipts(req(), "z@grmc.app", submitter).ok, false);
});

// ── allowedActions ──────────────────────────────────────────────────────────

test("allowedActions reflects the same rules the routes enforce", () => {
  const a = allowedActions(req({ status: "changes_requested" }), "a@grmc.app", submitter, false);
  assert.equal(a.resubmit, true);
  assert.equal(a.edit, true);
  assert.equal(a.decide, false);
  assert.equal(a.delete, true);
  const b = allowedActions(req(), "b@grmc.app", approver, false);
  assert.equal(b.decide, true);
  assert.equal(b.paperApprove, true);
  assert.equal(b.edit, false);
});

// ── reapprovalAfterEdit ─────────────────────────────────────────────────────

test("a small correction to an approved total just stands", () => {
  // $4 of tax on a $100 charge: fix it and log it, do not nag the approver.
  assert.equal(reapprovalAfterEdit("approved", 100, 104, 0.1, 25), false);
});

test("a large overrun on an approved total goes back for re-approval", () => {
  assert.equal(reapprovalAfterEdit("approved", 1000, 1200, 0.1, 25), true);
});

test("a correction downward never needs re-approval", () => {
  assert.equal(reapprovalAfterEdit("approved", 1000, 400, 0.1, 25), false);
});

test("corrections are measured against the approval, not the last correction", () => {
  // Approved at $100; already corrected to $120; now $140. $140 vs $100 is
  // over the $25 floor even though each step was under it.
  assert.equal(reapprovalAfterEdit("approved", 100, 140, 0.1, 25), true);
});

test("an undecided request is not re-approved \u2014 it was never approved", () => {
  for (const status of ["pending", "changes_requested"] as const) {
    assert.equal(reapprovalAfterEdit(status, 100, 5000, 0.1, 25), false);
  }
});

// ── needsReapproval ───────────────────────────────────────────────────────

test("an actual within the percentage closes out", () => {
  assert.equal(needsReapproval(1000, 1050, 0.1, 25), false);
});

test("an actual beyond both bounds returns for re-approval", () => {
  assert.equal(needsReapproval(1000, 1200, 0.1, 25), true);
});

test("the absolute floor protects small estimates from nagging", () => {
  // 10% of $100 is $10, but $25 is the more generous bound and wins.
  assert.equal(needsReapproval(100, 120, 0.1, 25), false);
  assert.equal(needsReapproval(100, 130, 0.1, 25), true);
});

test("the percentage takes over on large estimates", () => {
  // 10% of $5000 is $500, far more generous than the $25 floor.
  assert.equal(needsReapproval(5000, 5400, 0.1, 25), false);
  assert.equal(needsReapproval(5000, 5600, 0.1, 25), true);
});

test("spending less than estimated never needs re-approval", () => {
  assert.equal(needsReapproval(1000, 10, 0.1, 25), false);
});

test("exactly on the threshold does not trigger", () => {
  assert.equal(needsReapproval(1000, 1100, 0.1, 25), false);
});

test("a missing estimate cannot trigger re-approval", () => {
  assert.equal(needsReapproval(null, 5000, 0.1, 25), false);
});

// ── describeEdit ──────────────────────────────────────────────────────────

test("an edit records the fields that changed, from and to", () => {
  const changes = describeEdit({ amount: 100, vendor: "Costco" }, { amount: 118.42 });
  assert.deepEqual(changes, { amount: { from: 100, to: 118.42 } });
});

test("a field resubmitted unchanged is not recorded as a change", () => {
  assert.deepEqual(describeEdit({ amount: 100, vendor: "Costco" }, { amount: 100, vendor: "Costco" }), {});
});

test("a field the caller never sent is not recorded", () => {
  // The PATCH route passes undefined for anything absent from the body, and an
  // absent field means "leave it alone", not "clear it".
  assert.deepEqual(describeEdit({ amount: 100, vendor: "Costco" }, { vendor: undefined }), {});
});

test("line items are compared by content, not identity", () => {
  const before = { items: [{ title: "Chairs", price: 40 }] };
  assert.deepEqual(describeEdit(before, { items: [{ title: "Chairs", price: 40 }] }), {});
  const changed = describeEdit(before, { items: [{ title: "Chairs", price: 58 }] });
  assert.deepEqual(Object.keys(changed), ["items"]);
});

// ── roles (Phase 1) ───────────────────────────────────────────────────────

test("the office assistant cannot approve, even a request assigned to them", () => {
  const r = req({ approver_email: "office@grmc.app" });
  assert.equal(checkDecision(r, "office@grmc.app", assistant, "approve", "", false).ok, false);
  assert.equal(allowedActions(r, "office@grmc.app", assistant, false).decide, false);
});

test("paying a reimbursement needs the pay grant, not manage", () => {
  const r = req({ status: "approved", payment_method: "reimbursement" });
  assert.equal(checkReimburse(r, "office@grmc.app", { ...NO_PERMISSIONS, manage: true }).ok, false);
  assert.equal(checkReimburse(r, "office@grmc.app", { ...NO_PERMISSIONS, pay: true }).ok, true);
});

test("the office records a signed paper form for the assigned approver", () => {
  assert.equal(checkPaperApproval(req(), "office@grmc.app", assistant, false).ok, true);
  // ...but not for its own request, nor when the signer owns it.
  assert.equal(checkPaperApproval(req({ submitted_by_email: "office@grmc.app" }), "office@grmc.app", assistant, false).ok, false);
  assert.equal(checkPaperApproval(req({ purchased_by_email: "b@grmc.app" }), "office@grmc.app", assistant, false).ok, false);
  assert.equal(checkPaperApproval(req({ approver_email: "" }), "office@grmc.app", assistant, false).ok, false);
  // A plain submitter gets nothing from the paper path.
  assert.equal(checkPaperApproval(req(), "c@grmc.app", submitter, false).ok, false);
});

test("canSee: owners, keyer and assigned approver see a request; strangers do not", () => {
  const r = req({ purchased_by_email: "p@grmc.app", created_by_email: "k@grmc.app" });
  for (const who of ["a@grmc.app", "p@grmc.app", "k@grmc.app", "B@grmc.app"]) {
    assert.equal(canSee(r, who, submitter), true, who);
  }
  assert.equal(canSee(r, "c@grmc.app", approver), false);
  assert.equal(canSee(r, "", submitter), false);
});

test("canSee: the office, the payer and the accountant see everything", () => {
  assert.equal(canSee(req(), "c@grmc.app", assistant), true);
  assert.equal(canSee(req(), "c@grmc.app", { ...NO_PERMISSIONS, pay: true }), true);
  assert.equal(canSee(req(), "c@grmc.app", accountant), true);
});

test("the accountant can do nothing to a request but comment", () => {
  const states = [req(), req({ status: "approved", payment_method: "reimbursement" }),
                  req({ status: "approved", kind: "pre_purchase" })];
  for (const r of states) {
    const a = allowedActions(r, "cpa@grmc.app", accountant, false);
    const { comment, ...rest } = a;
    assert.equal(comment, true);
    assert.ok(Object.values(rest).every((v) => v === false), JSON.stringify(a));
  }
});

test("the office pays someone for a purchase it keyed for them; the payee still cannot", () => {
  const r = req({ status: "approved", payment_method: "reimbursement",
                  submitted_by_email: "office@grmc.app", purchased_by_email: "jane@grmc.app" });
  assert.equal(checkReimburse(r, "office@grmc.app", assistant).ok, true);
  assert.equal(checkReimburse(r, "jane@grmc.app", { ...NO_PERMISSIONS, pay: true }).ok, false);
});
