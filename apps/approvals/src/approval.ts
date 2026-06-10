export type Status = "pending" | "approved" | "rejected" | "changes_requested";
export type DecisionAction = "approve" | "reject" | "request_changes";

export interface RequestParties {
  submitter_email: string;
  approver_email: string;
  status: Status;
}

export type CheckResult = { ok: true } | { ok: false; status: number; error: string };

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function isApprover(req: RequestParties, email: string): boolean {
  return sameEmail(req.approver_email, email);
}

export function isSubmitter(req: RequestParties, email: string): boolean {
  return sameEmail(req.submitter_email, email);
}

export function statusAfterDecision(action: DecisionAction): Status {
  if (action === "approve") return "approved";
  if (action === "reject") return "rejected";
  return "changes_requested";
}

export function eventTypeForDecision(action: DecisionAction): string {
  return statusAfterDecision(action);
}

export function checkDecision(
  req: RequestParties, email: string, action: DecisionAction, comment: string
): CheckResult {
  if (!isApprover(req, email)) {
    return { ok: false, status: 403, error: "Only the assigned approver can decide this request." };
  }
  if (req.status !== "pending") {
    return { ok: false, status: 409, error: `Request is ${req.status}; it is no longer pending.` };
  }
  if (action === "request_changes" && !comment.trim()) {
    return { ok: false, status: 400, error: "A comment is required when requesting changes." };
  }
  return { ok: true };
}

export function checkVersionUpload(req: RequestParties, email: string): CheckResult {
  if (!isSubmitter(req, email)) {
    return { ok: false, status: 403, error: "Only the submitter can upload a new version." };
  }
  if (req.status !== "changes_requested") {
    return { ok: false, status: 409, error: "New versions can only be uploaded after changes are requested." };
  }
  return { ok: true };
}

export function canView(req: RequestParties, email: string): boolean {
  return isApprover(req, email) || isSubmitter(req, email);
}
