import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AdminCandidate, checkAdminChange, LAST_ADMIN_ERROR } from "./admin-guard";

const soleAdmin: AdminCandidate[] = [
  { id: "a1", is_admin: true, active: true },
  { id: "u1", is_admin: false, active: true },
];

const twoAdmins: AdminCandidate[] = [
  { id: "a1", is_admin: true, active: true },
  { id: "a2", is_admin: true, active: true },
];

test("demote, disable and delete of the sole active admin are all refused", () => {
  for (const type of ["demote", "disable", "delete"] as const) {
    assert.deepEqual(checkAdminChange(soleAdmin, { type, userId: "a1" }), {
      ok: false,
      error: LAST_ADMIN_ERROR,
    });
  }
});

test("the same changes are allowed once a second active admin exists", () => {
  for (const type of ["demote", "disable", "delete"] as const) {
    assert.deepEqual(checkAdminChange(twoAdmins, { type, userId: "a1" }), { ok: true });
  }
});

test("a disabled admin does not count toward the quorum", () => {
  const oneActiveOneDisabled: AdminCandidate[] = [
    { id: "a1", is_admin: true, active: true },
    { id: "a2", is_admin: true, active: false },
  ];
  assert.deepEqual(checkAdminChange(oneActiveOneDisabled, { type: "demote", userId: "a1" }), {
    ok: false,
    error: LAST_ADMIN_ERROR,
  });
});

test("changing a non-admin is always allowed", () => {
  assert.deepEqual(checkAdminChange(soleAdmin, { type: "delete", userId: "u1" }), { ok: true });
});

test("changing an already-disabled admin is allowed, since they are not holding the quorum", () => {
  const users: AdminCandidate[] = [
    { id: "a1", is_admin: true, active: true },
    { id: "a2", is_admin: true, active: false },
  ];
  assert.deepEqual(checkAdminChange(users, { type: "delete", userId: "a2" }), { ok: true });
});

test("an unknown user id is reported rather than silently allowed", () => {
  assert.deepEqual(checkAdminChange(soleAdmin, { type: "delete", userId: "nope" }), {
    ok: false,
    error: "User not found.",
  });
});
