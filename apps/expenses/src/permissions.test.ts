import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  LAST_ADMIN_ERROR,
  NO_PERMISSIONS,
  PermissionRow,
  ROLE_PRESETS,
  approvesAny,
  checkPermissionChange,
  effectivePermissions,
  isMember,
  roleOf,
  seesAll,
  seesReports,
} from "./permissions";

function row(over: Partial<PermissionRow> = {}): PermissionRow {
  return {
    email: "a@grmc.app", name: "A",
    can_submit: false, can_submit_for_others: false, can_edit_own: false,
    can_approve: false, can_manage: false, can_pay: false, can_audit: false, is_admin: false,
    default_approver_email: null,
    ...over,
  };
}

test("the office (manage) does not approve unless also given approve", () => {
  const p = effectivePermissions(row({ can_manage: true }));
  assert.equal(p.manage, true);
  assert.equal(p.approve, false);
  assert.equal(approvesAny(p), false);
  assert.equal(approvesAny(effectivePermissions(row({ can_manage: true, can_approve: true }))), true);
});

test("each role preset maps back to its name, and the four are distinct", () => {
  for (const [name, flags] of Object.entries(ROLE_PRESETS)) {
    assert.equal(roleOf(flags), name);
  }
  assert.equal(roleOf({ ...ROLE_PRESETS.assistant, can_approve: true }), null);
});

test("the office assistant prepares and pays but cannot approve", () => {
  const p = effectivePermissions(row(ROLE_PRESETS.assistant));
  assert.equal(p.approve, false);
  assert.equal(p.pay, true);
  assert.equal(seesAll(p), true);
});

test("the accountant sees everything and reports, and nothing else", () => {
  const p = effectivePermissions(row(ROLE_PRESETS.accountant));
  assert.equal(seesAll(p), true);
  assert.equal(seesReports(p), true);
  assert.equal(isMember(p), true);
  assert.equal(p.submit || p.approve || p.manage || p.pay || p.admin, false);
});

test("a plain submitter or approver sees only their own share", () => {
  assert.equal(seesAll(effectivePermissions(row(ROLE_PRESETS.submitter))), false);
  assert.equal(seesAll(effectivePermissions(row(ROLE_PRESETS.approver))), false);
  assert.equal(seesReports(effectivePermissions(row(ROLE_PRESETS.approver))), false);
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

test("edit-own is not a permission \u2014 submitting a request carries the right to revise it", () => {
  // The can_edit_own column stays on app_users so no data is destroyed, but
  // nothing reads it: the lifecycle guard decides own-edits from status alone.
  assert.deepEqual(Object.keys(NO_PERMISSIONS).sort(), [
    "admin", "approve", "audit", "defaultApprover", "manage", "pay", "submit", "submitForOthers",
  ]);
  assert.equal("editOwn" in effectivePermissions(row({ can_edit_own: true })), false);
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
