import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DigestRow, digestsFor, hourIn } from "./digest";

const now = new Date("2026-11-10T14:00:00Z");
function row(over: Partial<DigestRow> = {}): DigestRow {
  return {
    id: 7, amount: 120, estimated_amount: null, vendor: "Hobby Lobby", reason: "VBS crafts",
    submitted_by: "Ann Member", approver_email: "pastor@x.org", purchased_by_email: "",
    submitted_by_email: "ann@x.org", step_since: "2026-11-07T14:00:00Z", ...over,
  };
}
const ctx = { now, appUrl: "https://expenses.grmc.app/", orgName: "GRMC" };

test("each approver gets one email listing what waits for them, oldest age shown", () => {
  const out = digestsFor(
    [row(), row({ id: 8, approver_email: "PASTOR@x.org", estimated_amount: 300, step_since: now.toISOString() }),
     row({ id: 9, approver_email: "deacon@x.org" })],
    [], [], ctx);
  assert.deepEqual(out.map((d) => d.to).sort(), ["deacon@x.org", "pastor@x.org"]);
  const pastor = out.find((d) => d.to === "pastor@x.org")!;
  assert.equal(pastor.subject, "2 requests are waiting for your approval");
  assert.match(pastor.body, /\$120\.00 — Hobby Lobby \(Ann Member\), waiting 3 days/);
  assert.match(pastor.body, /\$300\.00 .* waiting since today/);
  assert.match(pastor.body, /https:\/\/expenses\.grmc\.app\/#\/r\/8/);
});

test("payers hear what is ready to pay, never their own reimbursement", () => {
  const ready = [row({ amount: 40 }), row({ id: 8, amount: 10.5, submitted_by_email: "office@x.org" })];
  const out = digestsFor([], ready, ["office@x.org", "Office@x.org", "treasurer@x.org"], ctx);
  assert.deepEqual(out.map((d) => [d.to, d.subject]).sort(), [
    ["office@x.org", "1 reimbursement ready to pay ($40.00)"],
    ["treasurer@x.org", "2 reimbursements ready to pay ($50.50)"],
  ]);
});

test("nothing waiting means no email at all", () => {
  assert.deepEqual(digestsFor([], [], ["office@x.org"], ctx), []);
});

test("the hour is read in the church's time zone", () => {
  assert.equal(hourIn(now, "America/Chicago"), 8);
  assert.equal(hourIn(now, "UTC"), 14);
});
