import { Permissions } from "./permissions";

export type RequestKind = "pre_purchase" | "post_purchase";
export type PaymentMethod = "church_card" | "reimbursement";
export type RequestStatus =
  | "pending"
  | "changes_requested"
  | "rejected"
  | "approved"
  | "withdrawn"
  | "voided";

export interface ExpenseRequest {
  id: number;
  kind: RequestKind;
  payment_method: PaymentMethod;
  status: RequestStatus;
  submitted_by_email: string;
  // Who actually bought it. Empty when the submitter bought it themselves or
  // the purchaser has no account; either way the submitter is then the owner.
  purchased_by_email: string;
  approver_email: string;
  amount: number;
  estimated_amount: number | null;
  approved_at: string | null;
  // What was last approved. Survives a return for re-approval, so "was this
  // ever approved?" and "how far has it moved since?" both have an answer.
  approved_amount: number | null;
  actuals_completed_at: string | null;
  reimbursed_at: string | null;
  voided_at: string | null;
  version: number;
}

export type Stage =
  | "Awaiting approval"
  | "Changes requested"
  | "Rejected"
  | "Approved — awaiting receipts"
  | "Approved — awaiting reimbursement"
  | "Complete"
  | "Withdrawn"
  | "Voided";

// Derived, never stored: `status` covers only the approval decision, and the
// milestone timestamps cover what has happened since. Computing the stage means
// the two can never contradict each other.
export function stageOf(req: ExpenseRequest): Stage {
  if (req.status === "voided") return "Voided";
  if (req.status === "withdrawn") return "Withdrawn";
  if (req.status === "pending") return "Awaiting approval";
  if (req.status === "changes_requested") return "Changes requested";
  if (req.status === "rejected") return "Rejected";

  // Approved. Receipts come first — they are the actionable next step, and a
  // reimbursement should not be paid before its actual amount is known.
  if (req.kind === "pre_purchase" && !req.actuals_completed_at) {
    return "Approved — awaiting receipts";
  }
  if (req.payment_method === "reimbursement" && !req.reimbursed_at) {
    return "Approved — awaiting reimbursement";
  }
  return "Complete";
}

export interface RequiredFields {
  card: boolean;
  receipts: boolean;
  estimate: boolean;
}

// Each answer depends on exactly one dimension, which is the point of keeping
// kind and payment method separate rather than collapsing them into a
// four-value type.
export function requiredFields(kind: RequestKind, payment: PaymentMethod): RequiredFields {
  return {
    card: payment === "church_card",
    receipts: kind === "post_purchase",
    estimate: kind === "pre_purchase",
  };
}

export type DecisionAction = "approve" | "reject" | "request_changes";
export type CheckResult = { ok: true } | { ok: false; status: number; error: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// The submitter AND the purchaser own a request. When the office keys a
// purchase for someone, the person who bought it must still be able to add the
// receipt, answer the approver — and must not be able to approve it.
export function isOwner(req: ExpenseRequest, email: string): boolean {
  if (!email.trim()) return false;
  return same(req.submitted_by_email, email) ||
    (!!req.purchased_by_email && same(req.purchased_by_email, email));
}

const ok: CheckResult = { ok: true };
const deny = (status: number, error: string): CheckResult => ({ ok: false, status, error });
const DEAD: RequestStatus[] = ["rejected", "withdrawn", "voided"];

// A decision always lands on one of these three terminal-ish states — never
// back on `pending` — and the narrowed return type says so, which is what lets
// these double as audit event names without a cast. Spelt out rather than
// derived from RequestStatus: `withdrawn` is a status too, but it is the
// submitter retiring a request, not an approver deciding one.
export type DecidedStatus = "approved" | "rejected" | "changes_requested";

export function statusAfterDecision(action: DecisionAction): DecidedStatus {
  if (action === "approve") return "approved";
  if (action === "reject") return "rejected";
  return "changes_requested";
}

export function checkDecision(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions,
  action: DecisionAction,
  comment: string,
  allowSelfApproval: boolean
): CheckResult {
  if (!perms.approve) {
    return { ok: false, status: 403, error: "You do not have permission to approve expenses." };
  }
  // A plain approver acts only on what is assigned to them; manage acts on any.
  if (!perms.manage && !same(req.approver_email, actorEmail)) {
    return { ok: false, status: 403, error: "Only the assigned approver can decide this request." };
  }
  // The control that makes the workflow worth having. manage does not bypass
  // it; only the explicit allow_self_approval setting does.
  if (!allowSelfApproval && isOwner(req, actorEmail)) {
    return { ok: false, status: 403, error: "You cannot decide your own request." };
  }
  if (req.status !== "pending") {
    return {
      ok: false,
      status: 409,
      error: `This request is ${req.status} and is no longer awaiting a decision.`,
    };
  }
  // The submitter is owed a reason either way — a bare "no" just produces the
  // same request again.
  if (action === "request_changes" && !comment.trim()) {
    return { ok: false, status: 400, error: "Say what needs to change." };
  }
  if (action === "reject" && !comment.trim()) {
    return { ok: false, status: 400, error: "Give a reason for rejecting." };
  }
  return { ok: true };
}

export function checkEdit(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions
): CheckResult {
  if (!perms.manage && !isOwner(req, actorEmail)) {
    return deny(403, "You do not have permission to edit this request.");
  }
  // Submitting a request carries the right to revise it — no separate grant
  // needed — but only while it is still awaiting a decision. manage reaches
  // one step further, into `approved`, because the charge that actually lands
  // is often not the one that was approved. Rejected, withdrawn and voided are
  // dead records; a paid reimbursement is closed money and stays as paid.
  const editable: RequestStatus[] = perms.manage
    ? ["pending", "changes_requested", "approved"]
    : ["pending", "changes_requested"];
  if (req.reimbursed_at) {
    return deny(409, "This request has been paid, so it can no longer be changed.");
  }
  if (!editable.includes(req.status)) {
    return deny(409, req.status === "approved"
      ? "This request is approved. Ask the office to correct it."
      : `This request is ${stageOf(req).toLowerCase()} and can no longer be edited.`);
  }
  return ok;
}

export function checkResubmit(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions
): CheckResult {
  if (!perms.manage && !isOwner(req, actorEmail)) {
    return deny(403, "Only the person who submitted this can send it back.");
  }
  if (req.status !== "changes_requested") {
    return deny(409, "Only a request with changes requested can be sent back to the approver.");
  }
  return ok;
}

export type DeleteMode = "hard" | "withdraw";
export type DeleteCheck =
  | { ok: true; mode: DeleteMode }
  | { ok: false; status: number; error: string };

// Before any approval there is nothing on the record worth keeping, so the row
// really goes. An approved pre-purchase that has not been bought yet can be
// withdrawn: nothing was spent. Anything else is money that has moved, and it
// stays on the books — manage can void it with a reason, nobody can delete it.
export function checkDelete(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions
): DeleteCheck {
  const owner = isOwner(req, actorEmail);
  if (!perms.manage && !owner) {
    return { ok: false, status: 403, error: "You can only delete your own requests." };
  }
  const undecided = req.status === "pending" || req.status === "changes_requested";
  if (undecided && req.approved_amount === null) return { ok: true, mode: "hard" };
  if (req.status === "approved" && req.kind === "pre_purchase" && !req.actuals_completed_at) {
    return { ok: true, mode: "withdraw" };
  }
  if (req.status === "withdrawn") {
    return { ok: false, status: 409, error: "This request has already been withdrawn." };
  }
  if (DEAD.includes(req.status)) {
    return { ok: false, status: 409, error: "This request is closed and stays on the record." };
  }
  return {
    ok: false,
    status: 409,
    error: perms.manage
      ? "This request has already been approved. Use Void to take it off the books with a reason."
      : "This money has already been spent, so the request stays on the record. Ask the office if something is wrong.",
  };
}

export function checkVoid(req: ExpenseRequest, perms: Permissions, reason: string): CheckResult {
  if (!perms.manage) return deny(403, "Only the office can void a request.");
  if (req.status === "voided" || req.status === "withdrawn") {
    return deny(409, "This request is already off the books.");
  }
  if (req.reimbursed_at) {
    return deny(409, "This request has been paid, so it cannot be voided.");
  }
  if (!reason.trim()) return deny(400, "Say why this request is being voided.");
  return ok;
}

export function checkActuals(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions
): CheckResult {
  if (!perms.manage && !isOwner(req, actorEmail)) {
    return deny(403, "Only the person who made the purchase can complete this request.");
  }
  if (req.kind !== "pre_purchase") {
    return deny(409, "Only a pre-purchase request is completed with actuals.");
  }
  if (req.status !== "approved") return deny(409, "This request has not been approved yet.");
  if (req.actuals_completed_at) {
    return deny(409, "The actual cost is already recorded. Ask the office to correct it.");
  }
  return ok;
}

export function checkReimburse(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions
): CheckResult {
  if (!perms.manage) return deny(403, "Only the office records reimbursements.");
  // Church-card money was never the person's to get back.
  if (req.payment_method !== "reimbursement") return deny(409, "This request is not a reimbursement.");
  if (req.status !== "approved") return deny(409, "This request has not been approved yet.");
  if (req.kind === "pre_purchase" && !req.actuals_completed_at) {
    return deny(409, "Add the actual amount and receipts before reimbursing.");
  }
  if (req.reimbursed_at) return deny(409, "This request has already been marked paid.");
  if (isOwner(req, actorEmail)) return deny(403, "Someone else must record paying you.");
  return ok;
}

export function checkAddReceipts(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions
): CheckResult {
  if (!perms.manage && !isOwner(req, actorEmail)) {
    return deny(403, "Only the person who submitted this can add receipts.");
  }
  if (DEAD.includes(req.status)) return deny(409, "This request is closed.");
  return ok;
}

export interface AllowedActions {
  edit: boolean;
  resubmit: boolean;
  decide: boolean;
  paperApprove: boolean;
  completeActuals: boolean;
  reimburse: boolean;
  withdraw: boolean;
  delete: boolean;
  void: boolean;
  addReceipts: boolean;
  comment: boolean;
}

// The same checks the routes run, asked up front, so the page shows exactly
// the buttons that will work and never mirrors these rules in the browser.
export function allowedActions(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions,
  allowSelfApproval: boolean
): AllowedActions {
  const del = checkDelete(req, actorEmail, perms);
  // A comment is only a reason for these checks, so a placeholder satisfies it.
  const decide = checkDecision(req, actorEmail, perms, "approve", "x", allowSelfApproval).ok;
  return {
    edit: checkEdit(req, actorEmail, perms).ok,
    resubmit: checkResubmit(req, actorEmail, perms).ok,
    decide,
    paperApprove: decide,
    completeActuals: checkActuals(req, actorEmail, perms).ok,
    reimburse: checkReimburse(req, actorEmail, perms).ok,
    withdraw: del.ok && del.mode === "withdraw",
    delete: del.ok && del.mode === "hard",
    void: checkVoid(req, perms, "x").ok && !(del.ok && del.mode === "hard"),
    addReceipts: checkAddReceipts(req, actorEmail, perms).ok,
    comment: true,
  };
}

// Tolerance is the GREATER of a percentage and an absolute amount, so a $2 tax
// difference on a small purchase does not go back to the approver while a real
// overrun on a large one still does.
export function needsReapproval(
  estimate: number | null,
  actual: number,
  tolerancePct: number,
  toleranceAbs: number
): boolean {
  if (estimate === null || !Number.isFinite(estimate) || estimate <= 0) return false;
  const threshold = Math.max(estimate * tolerancePct, toleranceAbs);
  return actual - estimate > threshold;
}

// A manager correcting an approved total is usually reconciling it with what
// the card was actually charged, which should not drag the approver back in.
// A real overrun should. The threshold is the one pre-purchase actuals already
// use, so the two paths cannot drift apart. The caller passes the APPROVED
// amount, not the previous one — otherwise a run of small corrections walks
// the total anywhere without the approver ever seeing it.
export function reapprovalAfterEdit(
  previousStatus: RequestStatus,
  approvedAmount: number,
  newAmount: number,
  tolerancePct: number,
  toleranceAbs: number
): boolean {
  if (previousStatus !== "approved") return false;
  return needsReapproval(approvedAmount, newAmount, tolerancePct, toleranceAbs);
}

export type FieldChange = { from: unknown; to: unknown };

// What an edit actually moved, for the audit trail. Only fields the caller sent
// are considered — an absent field means "leave it alone", not "clear it" — and
// only those whose value really changed, so resubmitting a form untouched logs
// an edit with nothing in it rather than a wall of noise.
export function describeEdit(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  for (const [field, to] of Object.entries(after)) {
    if (to === undefined) continue;
    const from = before[field];
    const unchanged =
      to !== null && typeof to === "object"
        ? JSON.stringify(from) === JSON.stringify(to)
        : from === to;
    // `from` is normalised to null because this lands in a jsonb column, and
    // JSON.stringify drops undefined keys entirely.
    if (!unchanged) changes[field] = { from: from ?? null, to };
  }
  return changes;
}
