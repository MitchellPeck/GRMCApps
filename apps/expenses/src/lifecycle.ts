import { Permissions } from "./permissions";

export type RequestKind = "pre_purchase" | "post_purchase";
export type PaymentMethod = "church_card" | "reimbursement";
export type RequestStatus =
  | "pending"
  | "changes_requested"
  | "rejected"
  | "approved"
  | "withdrawn";

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
  | "Complete"
  | "Withdrawn";

// Derived, never stored: `status` covers only the approval decision, and the
// milestone timestamps cover what has happened since. Computing the stage means
// the two can never contradict each other.
export function stageOf(req: ExpenseRequest): Stage {
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
  if (!perms.manage && !own) {
    return { ok: false, status: 403, error: "You do not have permission to edit this request." };
  }
  // Submitting a request carries the right to revise it — no separate grant
  // needed — but only while it is still awaiting a decision. manage reaches
  // one step further, into `approved`, because the charge that actually lands
  // is often not the one that was approved. Rejected and withdrawn are dead
  // records: superseded by a new request, never edited back to life.
  const editable: RequestStatus[] = perms.manage
    ? ["pending", "changes_requested", "approved"]
    : ["pending", "changes_requested"];
  if (!editable.includes(req.status)) {
    return {
      ok: false,
      status: 409,
      error:
        req.status === "approved"
          ? "This request is approved. Ask a manager to correct it."
          : `This request is ${req.status} and can no longer be edited.`,
    };
  }
  return { ok: true };
}

export type DeleteMode = "hard" | "withdraw";
export type DeleteCheck =
  | { ok: true; mode: DeleteMode }
  | { ok: false; status: number; error: string };

// Deleting your own request is never refused outright — only downgraded. Before
// a decision there is nothing on the record worth keeping, so the row really
// goes. After one, removing it would take an approval, its receipts and its
// history with it and silently move past spend totals, so it is withdrawn
// instead: out of the reports, still on the record.
export function checkDelete(
  req: ExpenseRequest,
  actorEmail: string,
  perms: Permissions
): DeleteCheck {
  // manage keeps the unconditional delete it has always had — the escape hatch
  // for genuine junk, test rows and duplicates.
  if (perms.manage) return { ok: true, mode: "hard" };
  if (!same(req.submitted_by_email, actorEmail)) {
    return { ok: false, status: 403, error: "You can only delete your own requests." };
  }
  if (req.status === "pending" || req.status === "changes_requested") {
    return { ok: true, mode: "hard" };
  }
  if (req.status === "withdrawn") {
    return { ok: false, status: 409, error: "This request has already been withdrawn." };
  }
  return { ok: true, mode: "withdraw" };
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
// use, so the two paths cannot drift apart.
export function reapprovalAfterEdit(
  previousStatus: RequestStatus,
  previousAmount: number,
  newAmount: number,
  tolerancePct: number,
  toleranceAbs: number
): boolean {
  if (previousStatus !== "approved") return false;
  return needsReapproval(previousAmount, newAmount, tolerancePct, toleranceAbs);
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
