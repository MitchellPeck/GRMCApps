import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decideAccess, roleHeader } from "./access-decision";

test("a granted, active user on an enabled app is allowed", () => {
  assert.deepEqual(
    decideAccess({ userActive: true, appEnabled: true, hasGrant: true }),
    { allowed: true }
  );
});

test("a missing grant denies", () => {
  assert.deepEqual(
    decideAccess({ userActive: true, appEnabled: true, hasGrant: false }),
    { allowed: false, reason: "no_grant" }
  );
});

test("a disabled user denies even with a grant", () => {
  assert.deepEqual(
    decideAccess({ userActive: false, appEnabled: true, hasGrant: true }),
    { allowed: false, reason: "user_disabled" }
  );
});

test("a disabled app denies first, before user state", () => {
  assert.deepEqual(
    decideAccess({ userActive: false, appEnabled: false, hasGrant: true }),
    { allowed: false, reason: "app_disabled" }
  );
});

test("roleHeader reports admin separately from app access", () => {
  assert.equal(roleHeader(true), "admin");
  assert.equal(roleHeader(false), "user");
});
