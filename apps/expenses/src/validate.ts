import type { PaymentMethod, RequestKind } from "./lifecycle";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Round-trips through Date so 2026-02-30 is caught, not just the shape.
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// The church's own calendar day. The host runs in the church's timezone, so
// the local date is the one people mean by "today".
export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// null for anything that is not a usable amount — "abc", "", negatives,
// Infinity — so callers never store NaN or a credit by accident.
export function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

// Discounts are negative lines, so this is a plain sum. Half a cent of slack
// absorbs float noise; anything a person could see is a mismatch.
export function itemsMatch(items: { price: number }[], amount: number): boolean {
  const total = items.reduce((s, i) => s + (Number(i.price) || 0), 0);
  return Math.abs(total - amount) < 0.005;
}

export interface SubmissionInput {
  kind: RequestKind;
  paymentMethod: PaymentMethod;
  requestDate: string;
  amount: number;
  estimatedAmount: number | null;
  reason: string;
  approverEmail: string;
  purchasedByEmail: string;
  cardId: number | null;
  items: { price: number }[];
}

export interface SubmissionContext {
  today: string;
  actorEmail: string;
  approverEmails: string[];
  allowSelfApproval: boolean;
  // Active cards the purchaser may charge to.
  cardIdsForPurchaser: number[];
}

// The first problem, in words the submitter can act on; null when it is fine.
export function validateSubmission(i: SubmissionInput, c: SubmissionContext): string | null {
  if (!isIsoDate(i.requestDate)) return "Enter the date of the purchase.";
  if (i.requestDate > c.today) return "The date can't be in the future.";
  if (!i.reason.trim()) return "Say what this was for.";
  if (i.purchasedByEmail && !/^[^@\s]+@[^@\s]+$/.test(i.purchasedByEmail)) {
    return "Choose the purchaser from the list of people.";
  }

  if (i.kind === "pre_purchase") {
    if (!(i.estimatedAmount !== null && i.estimatedAmount > 0)) return "Enter an estimated amount.";
  } else {
    if (!(i.amount > 0)) return "Enter the amount that was spent.";
    if (i.items.length && !itemsMatch(i.items, i.amount)) {
      return "The line items don't add up to the amount. Fix one or the other.";
    }
  }

  if (!i.approverEmail.trim()) return "Choose an approver.";
  if (!c.approverEmails.some((e) => same(e, i.approverEmail))) {
    return "That person can't approve expenses. Choose someone from the list.";
  }
  if (!c.allowSelfApproval) {
    if (same(i.approverEmail, c.actorEmail)) return "You can't name yourself as the approver. Choose someone else.";
    if (i.purchasedByEmail && same(i.approverEmail, i.purchasedByEmail)) {
      return "The person who bought it can't approve it. Choose someone else.";
    }
  }

  if (i.paymentMethod === "church_card") {
    if (!i.cardId) return "Choose the card this was charged to.";
    if (!c.cardIdsForPurchaser.includes(i.cardId)) {
      return "That card isn't one the purchaser can use. Choose another.";
    }
  }
  return null;
}
