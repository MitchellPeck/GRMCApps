import { Permissions } from "./permissions";

export type RequestKind = "pre_purchase" | "post_purchase";
export type PaymentMethod = "church_card" | "reimbursement";
export type RequestStatus = "pending" | "changes_requested" | "rejected" | "approved";

export interface ExpenseRequest {
  id: number;
  kind: RequestKind;
  payment_method: PaymentMethod;
  status: RequestStatus;
  submitted_by_email: string;
  approver_email: string;
  amount: number;
  estimated_amount: number | null;
  approved_at: string | null;
  actuals_completed_at: string | null;
  reimbursed_at: string | null;
}

export type Stage =
  | "Awaiting approval"
  | "Changes requested"
  | "Rejected"
  | "Approved — awaiting receipts"
  | "Approved — awaiting reimbursement"
  | "Complete";

// Derived, never stored: `status` covers only the approval decision, and the
// milestone timestamps cover what has happened since. Computing the stage means
// the two can never contradict each other.
export function stageOf(req: ExpenseRequest): Stage {
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

// A decision always lands on one of three terminal-ish states — never back on
// `pending` — and the narrowed return type says so, which is what lets these
// double as audit event names without a cast.
export type DecidedStatus = Exclude<RequestStatus, "pending">;

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
  if (!allowSelfApproval && same(req.submitted_by_email, actorEmail)) {
    return { ok: false, status: 403, error: "You cannot decide your own request." };
  }
  if (req.status !== "pending") {
    return {
      ok: false,
      status: 409,
      error: `This request is ${req.status} and is no longer awaiting a decision.`,
    };
  }
  if (action === "request_changes" && !comment.trim()) {
    return { ok: false, status: 400, error: "A comment is required when requesting changes." };
  }
  return { ok: true };
}

export function checkEdit(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions
): CheckResult {
  const own = same(req.submitted_by_email, actorEmail);
  if (!perms.manage && !(perms.editOwn && own)) {
    return { ok: false, status: 403, error: "You do not have permission to edit this request." };
  }
  // An approved or rejected request is a decision on record: it is superseded,
  // never silently altered.
  if (req.status !== "pending" && req.status !== "changes_requested") {
    return {
      ok: false,
      status: 409,
      error: `This request is ${req.status} and can no longer be edited.`,
    };
  }
  return { ok: true };
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
