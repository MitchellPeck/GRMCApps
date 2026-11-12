import type { EventType } from "./events";
import type { ExpenseRequest } from "./lifecycle";

// Who hears about what. Pure, so the whole policy is testable without a
// database or a mail provider: an event and the request as it stands after
// that event go in, the emails to send come out.

export interface NotifyRequest extends ExpenseRequest {
  vendor: string;
  reason: string;
  submitted_by: string;
}

export interface NotifyContext {
  actorEmail: string;
  actorName: string;
  comment: string;
  meta: Record<string, unknown> | null;
  // Everyone who can record a reimbursement.
  payers: string[];
  appUrl: string;
  orgName: string;
}

export interface Draft {
  to: string;
  kind: EventType | "ready_to_pay";
  subject: string;
  body: string;
}

export const NOTIFIABLE: ReadonlySet<EventType> = new Set<EventType>([
  "submitted", "resubmitted", "reapproval_required",
  "approved", "approved_on_paper", "rejected", "changes_requested",
  "actuals_completed", "reimbursed", "voided", "comment",
  "reminded", "reassigned",
]);

const money = (n: number | null | undefined) =>
  "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function what(r: NotifyRequest): string {
  const text = (r.vendor || r.reason || `request #${r.id}`).trim();
  return text.length > 60 ? text.slice(0, 57) + "…" : text;
}

function owners(r: NotifyRequest): string[] {
  return [r.submitted_by_email, r.purchased_by_email];
}

// The person a reimbursement pays back.
function payee(r: NotifyRequest): string {
  return r.purchased_by_email || r.submitted_by_email;
}

function readyToPay(r: NotifyRequest): boolean {
  return r.status === "approved" && r.payment_method === "reimbursement" && !r.reimbursed_at &&
    (r.kind === "post_purchase" || !!r.actuals_completed_at);
}

function nextStepAfterApproval(r: NotifyRequest): string {
  if (r.kind === "pre_purchase" && !r.actuals_completed_at) {
    return "Next: make the purchase, then open the request and record what it actually cost, with the receipt.";
  }
  if (r.payment_method === "reimbursement" && !r.reimbursed_at) {
    return "Next: the office will pay you back. You don't need to do anything.";
  }
  return "There is nothing more for you to do.";
}

export function notificationsFor(type: EventType, r: NotifyRequest, ctx: NotifyContext): Draft[] {
  if (!NOTIFIABLE.has(type)) return [];
  const who = ctx.actorName || ctx.actorEmail;
  const link = ctx.appUrl ? `\n\nOpen it: ${ctx.appUrl.replace(/\/$/, "")}/#/r/${r.id}` : "";
  const sign = `\n\n— ${ctx.orgName ? ctx.orgName + " " : ""}Expenses`;
  const quoted = ctx.comment.trim() ? `\n\n"${ctx.comment.trim()}"` : "";
  const out: Draft[] = [];
  const add = (to: string[], kind: Draft["kind"], subject: string, text: string) => {
    for (const t of to) out.push({ to: t, kind, subject, body: text + link + sign });
  };

  switch (type) {
    case "submitted":
      add([r.approver_email], type, `Please approve: ${money(r.estimated_amount ?? r.amount)} — ${what(r)}`,
        `${who} is asking you to approve ${money(r.estimated_amount ?? r.amount)} for ${r.reason || what(r)}.`);
      break;
    case "resubmitted":
      add([r.approver_email], type, `Sent back to you: ${what(r)}`,
        `${who} made the changes you asked for and sent ${what(r)} back for approval.${quoted}`);
      break;
    case "reapproval_required":
      add([r.approver_email], type, `Please approve again: ${what(r)} is now ${money(r.amount)}`,
        `You approved ${money(r.approved_amount)} for ${what(r)}. It is now ${money(r.amount)}, ` +
        `which is more than the allowed difference, so it needs your approval again.`);
      break;
    case "approved":
    case "approved_on_paper":
      add(owners(r), "approved", `Approved: ${what(r)}`,
        `${money(r.approved_amount ?? r.amount)} for ${what(r)} was approved.\n\n${nextStepAfterApproval(r)}`);
      if (readyToPay(r)) {
        add(ctx.payers.filter((p) => !same(p, payee(r))), "ready_to_pay",
          `Ready to pay: ${money(r.amount)} to ${r.submitted_by || payee(r)}`,
          `${what(r)} is approved and ready to be reimbursed.`);
      }
      break;
    case "rejected":
      add(owners(r), type, `Not approved: ${what(r)}`,
        `${who} did not approve ${what(r)}.${quoted}`);
      break;
    case "changes_requested":
      add(owners(r), type, `Changes needed: ${what(r)}`,
        `${who} asked for changes to ${what(r)} before approving it.${quoted}\n\n` +
        `Open the request, make the changes, then press "Send back to approver".`);
      break;
    case "actuals_completed":
      if (readyToPay(r)) {
        add(ctx.payers.filter((p) => !same(p, payee(r))), "ready_to_pay",
          `Ready to pay: ${money(r.amount)} to ${r.submitted_by || payee(r)}`,
          `The actual cost of ${what(r)} is in and it is ready to be reimbursed.`);
      }
      break;
    case "reimbursed": {
      const paidOn = typeof ctx.meta?.paidOn === "string" ? ` on ${ctx.meta.paidOn}` : "";
      const ref = ctx.comment.trim() ? ` (${ctx.comment.trim()})` : "";
      add([payee(r)], type, `Paid: ${money(r.amount)} for ${what(r)}`,
        `You were paid back ${money(r.amount)} for ${what(r)}${paidOn}${ref}.`);
      break;
    }
    case "voided":
      add(owners(r), type, `Voided: ${what(r)}`, `${who} voided ${what(r)}.${quoted}`);
      break;
    case "comment":
      add([...owners(r), r.approver_email], type, `New comment on ${what(r)}`, `${who} wrote:${quoted}`);
      break;
    case "reminded": {
      const amount = money(r.estimated_amount ?? r.amount);
      const note = quoted ? `\n\n${who} added:${quoted}` : "";
      switch (ctx.meta?.reason) {
        case "approval":
          add([r.approver_email], type, `Reminder: please approve ${what(r)}`,
            `${amount} for ${r.reason || what(r)} is still waiting for your approval.${note}`);
          break;
        case "changes":
          add(owners(r), type, `Reminder: changes needed on ${what(r)}`,
            `${what(r)} is still waiting for the changes the approver asked for.${note}\n\n` +
            `Open the request, make the changes, then press "Send back to approver".`);
          break;
        case "actuals":
          add(owners(r), type, `Reminder: what did ${what(r)} cost?`,
            `Once you have bought it, open the request and record what ${what(r)} actually cost, ` +
            `with the receipt.${note}`);
          break;
        case "receipt":
          if (ctx.meta?.keyed) {
            add(owners(r), type, `Receipt needed: ${amount} at ${what(r)}`,
              `${who} entered a ${amount} purchase at ${what(r)} for you. ` +
              `We don't have a receipt for it yet — open the request and add a photo or PDF of it.${note}`);
          } else {
            add(owners(r), type, `Reminder: receipt needed for ${what(r)}`,
              `We don't have a receipt for ${what(r)} (${amount}) yet. ` +
              `Open the request and add a photo or PDF of it.${note}`);
          }
          break;
      }
      break;
    }
    case "reassigned":
      if (r.status === "pending") {
        add([r.approver_email], type, `Please approve: ${money(r.estimated_amount ?? r.amount)} — ${what(r)}`,
          `${who} passed ${what(r)} (${money(r.estimated_amount ?? r.amount)}) to you to approve.${quoted}`);
      }
      break;
  }

  // One email per person per event, never to whoever caused it.
  const seen = new Set<string>();
  return out.filter((d) => {
    const key = d.to.trim().toLowerCase();
    if (!key || !key.includes("@") || same(key, ctx.actorEmail) || seen.has(key + d.kind)) return false;
    seen.add(key + d.kind);
    d.to = key;
    return true;
  });
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
