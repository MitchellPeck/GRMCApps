import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isApprover, isSubmitter, statusAfterDecision, eventTypeForDecision,
  checkDecision, checkVersionUpload, RequestParties,
} from "./approval";

const base: RequestParties = {
  submitter_email: "sub@x.com",
  approver_email: "appr@x.com",
  status: "pending",
};

test("party checks are case-insensitive on email", () => {
  assert.equal(isApprover(base, "APPR@x.com"), true);
  assert.equal(isApprover(base, "sub@x.com"), false);
  assert.equal(isSubmitter(base, "Sub@X.com"), true);
});

test("statusAfterDecision / eventTypeForDecision map each action", () => {
  assert.equal(statusAfterDecision("approve"), "approved");
  assert.equal(statusAfterDecision("reject"), "rejected");
  assert.equal(statusAfterDecision("request_changes"), "changes_requested");
  assert.equal(eventTypeForDecision("approve"), "approved");
  assert.equal(eventTypeForDecision("request_changes"), "changes_requested");
});

test("checkDecision allows the approver on a pending request", () => {
  assert.deepEqual(checkDecision(base, "appr@x.com", "approve", ""), { ok: true });
});

test("checkDecision rejects a non-approver with 403", () => {
  const r = checkDecision(base, "sub@x.com", "approve", "");
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 403);
});

test("checkDecision rejects when not pending with 409", () => {
  const r = checkDecision({ ...base, status: "approved" }, "appr@x.com", "approve", "");
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 409);
});

test("checkDecision requires a comment for request_changes (400)", () => {
  const r = checkDecision(base, "appr@x.com", "request_changes", "   ");
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 400);
});

test("checkVersionUpload allows submitter only when changes_requested", () => {
  const cr: RequestParties = { ...base, status: "changes_requested" };
  assert.deepEqual(checkVersionUpload(cr, "sub@x.com"), { ok: true });
  assert.equal(checkVersionUpload(cr, "appr@x.com").ok, false); // not submitter -> 403
  assert.equal((checkVersionUpload(cr, "appr@x.com") as { status: number }).status, 403);
  assert.equal(checkVersionUpload(base, "sub@x.com").ok, false); // pending, not changes_requested -> 409
  assert.equal((checkVersionUpload(base, "sub@x.com") as { status: number }).status, 409);
});
