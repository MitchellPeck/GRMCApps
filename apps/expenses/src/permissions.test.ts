import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  LAST_ADMIN_ERROR,
  NO_PERMISSIONS,
  PermissionRow,
  checkPermissionChange,
  effectivePermissions,
} from "./permissions";

function row(over: Partial<PermissionRow> = {}): PermissionRow {
  return {
    email: "a@grmc.app", name: "A",
    can_submit: false, can_submit_for_others: false, can_edit_own: false,
    can_approve: false, can_manage: false, is_admin: false,
    default_approver_email: null,
    ...over,
  };
}

test("manage implies approve", () => {
  const p = effectivePermissions(row({ can_manage: true }));
  assert.equal(p.manage, true);
  assert.equal(p.approve, true);
});

test("admin implies nothing else", () => {
  const p = effectivePermissions(row({ is_admin: true }));
  assert.equal(p.admin, true);
  assert.equal(p.approve, false);
  assert.equal(p.submit, false);
  assert.equal(p.manage, false);
});

test("a missing row means no permissions at all", () => {
  assert.deepEqual(effectivePermissions(null), NO_PERMISSIONS);
  assert.equal(NO_PERMISSIONS.submit, false);
  assert.equal(NO_PERMISSIONS.admin, false);
});

test("plain approve does not imply manage", () => {
  const p = effectivePermissions(row({ can_approve: true }));
  assert.equal(p.approve, true);
  assert.equal(p.manage, false);
});

const soleAdmin: PermissionRow[] = [
  row({ email: "a@grmc.app", is_admin: true }),
  row({ email: "b@grmc.app", can_submit: true }),
];
const twoAdmins: PermissionRow[] = [
  row({ email: "a@grmc.app", is_admin: true }),
  row({ email: "b@grmc.app", is_admin: true }),
];

test("demoting or removing the sole admin is refused", () => {
  for (const type of ["demote", "remove"] as const) {
    assert.deepEqual(checkPermissionChange(soleAdmin, { type, email: "a@grmc.app" }), {
      ok: false, error: LAST_ADMIN_ERROR,
    });
  }
});

test("the same changes are allowed with a second admin", () => {
  for (const type of ["demote", "remove"] as const) {
    assert.deepEqual(checkPermissionChange(twoAdmins, { type, email: "a@grmc.app" }), { ok: true });
  }
});

test("changing a non-admin is always allowed", () => {
  assert.deepEqual(checkPermissionChange(soleAdmin, { type: "remove", email: "b@grmc.app" }), { ok: true });
});

test("email comparison is case-insensitive", () => {
  assert.deepEqual(checkPermissionChange(soleAdmin, { type: "demote", email: "A@GRMC.APP" }), {
    ok: false, error: LAST_ADMIN_ERROR,
  });
});

test("an unknown email is reported rather than silently allowed", () => {
  assert.deepEqual(checkPermissionChange(soleAdmin, { type: "remove", email: "nope@grmc.app" }), {
    ok: false, error: "No permissions found for that user.",
  });
});
