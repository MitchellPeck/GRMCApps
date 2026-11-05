import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SubmissionInput, isIsoDate, itemsMatch, parseMoney, todayIso, validateSubmission } from "./validate";

test("isIsoDate accepts real calendar dates only", () => {
  assert.equal(isIsoDate("2026-11-05"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("11/5"), false);
  assert.equal(isIsoDate(""), false);
});

test("parseMoney takes finite, non-negative amounts to the cent", () => {
  assert.equal(parseMoney("12.345"), 12.35);
  assert.equal(parseMoney(0), 0);
  assert.equal(parseMoney("abc"), null);
  assert.equal(parseMoney(-1), null);
  assert.equal(parseMoney(Infinity), null);
  assert.equal(parseMoney(""), null);
});

test("itemsMatch allows a sub-cent rounding difference only", () => {
  assert.equal(itemsMatch([{ price: 10.1 }, { price: 20.2 }], 30.3), true);
  assert.equal(itemsMatch([{ price: 10 }, { price: -2 }], 8), true);
  assert.equal(itemsMatch([{ price: 10 }], 10.02), false);
});

const ctx = {
  today: "2026-11-05",
  actorEmail: "office@grmc.app",
  approverEmails: ["pastor@grmc.app", "office@grmc.app"],
  allowSelfApproval: false,
  cardIdsForPurchaser: [7],
};

function input(over: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    kind: "post_purchase",
    paymentMethod: "church_card",
    requestDate: "2026-11-01",
    amount: 42,
    estimatedAmount: null,
    reason: "VBS crafts",
    approverEmail: "pastor@grmc.app",
    purchasedByEmail: "",
    cardId: 7,
    items: [],
    ...over,
  };
}

test("a complete submission passes", () => {
  assert.equal(validateSubmission(input(), ctx), null);
});

test("each missing or wrong field gets a plain-English reason", () => {
  assert.match(validateSubmission(input({ requestDate: "" }), ctx)!, /date/i);
  assert.match(validateSubmission(input({ requestDate: "2026-12-01" }), ctx)!, /future/i);
  assert.match(validateSubmission(input({ reason: "  " }), ctx)!, /what this was for/i);
  assert.match(validateSubmission(input({ amount: 0 }), ctx)!, /amount/i);
  assert.match(validateSubmission(input({ approverEmail: "nobody@grmc.app" }), ctx)!, /can.t approve/i);
  assert.match(validateSubmission(input({ cardId: 99 }), ctx)!, /card/i);
  assert.match(validateSubmission(input({ cardId: null }), ctx)!, /card/i);
  assert.match(validateSubmission(input({ items: [{ price: 40 }] }), ctx)!, /line items/i);
  assert.match(validateSubmission(input({ purchasedByEmail: "not an email" }), ctx)!, /purchaser/i);
});

test("a pre-purchase needs an estimate, not an amount, and skips the item total", () => {
  const pre = input({ kind: "pre_purchase", amount: 0, estimatedAmount: 300, items: [{ price: 10 }] });
  assert.equal(validateSubmission(pre, ctx), null);
  assert.match(validateSubmission({ ...pre, estimatedAmount: 0 }, ctx)!, /estimate/i);
});

test("you cannot name yourself, or the purchaser, as approver", () => {
  assert.match(validateSubmission(input({ approverEmail: "office@grmc.app" }), ctx)!, /yourself/i);
  const keyed = input({ purchasedByEmail: "pastor@grmc.app" });
  assert.match(validateSubmission(keyed, ctx)!, /bought it/i);
  assert.equal(validateSubmission(keyed, { ...ctx, allowSelfApproval: true }), null);
});

test("a reimbursement needs no card", () => {
  assert.equal(validateSubmission(input({ paymentMethod: "reimbursement", cardId: null }), ctx), null);
});

test("today is the church's date, not the server's UTC date", () => {
  // 9pm Central on Nov 5 is already Nov 6 in UTC.
  const evening = new Date("2026-11-06T03:00:00Z");
  assert.equal(todayIso(evening, "America/Chicago"), "2026-11-05");
  assert.equal(todayIso(evening, "UTC"), "2026-11-06");
});
