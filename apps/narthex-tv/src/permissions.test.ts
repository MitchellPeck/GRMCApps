import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPermissionChange, effectivePermissions, LAST_ADMIN_ERROR, NO_PERMISSIONS, PermissionRow,
} from "./permissions";

function row(over: Partial<PermissionRow>): PermissionRow {
  return {
    email: "a@b.c", name: "", can_upload: false, can_schedule: false,
    can_manage: false, is_admin: false, ...over,
  };
}

test("someone with no row has no permissions", () => {
  assert.deepEqual(effectivePermissions(null), NO_PERMISSIONS);
});

test("manage implies schedule, and scheduling implies uploading", () => {
  const p = effectivePermissions(row({ can_manage: true }));
  assert.deepEqual(p, { upload: true, schedule: true, manage: true, admin: false });
});

test("scheduling implies uploading but not managing", () => {
  const p = effectivePermissions(row({ can_schedule: true }));
  assert.deepEqual(p, { upload: true, schedule: true, manage: false, admin: false });
});

test("admin on its own grants the settings screen, not the TV", () => {
  const p = effectivePermissions(row({ is_admin: true }));
  assert.deepEqual(p, { upload: false, schedule: false, manage: false, admin: true });
});

test("the last administrator cannot be demoted or removed", () => {
  const rows = [row({ email: "solo@x.org", is_admin: true }), row({ email: "other@x.org" })];
  assert.deepEqual(checkPermissionChange(rows, { type: "demote", email: "solo@x.org" }), {
    ok: false,
    error: LAST_ADMIN_ERROR,
  });
  assert.deepEqual(checkPermissionChange(rows, { type: "remove", email: "SOLO@x.org" }), {
    ok: false,
    error: LAST_ADMIN_ERROR,
  });
  // A non-admin is always removable.
  assert.deepEqual(checkPermissionChange(rows, { type: "remove", email: "other@x.org" }), { ok: true });
});

test("one of two administrators can be demoted", () => {
  const rows = [
    row({ email: "a@x.org", is_admin: true }),
    row({ email: "b@x.org", is_admin: true }),
  ];
  assert.deepEqual(checkPermissionChange(rows, { type: "demote", email: "a@x.org" }), { ok: true });
});
