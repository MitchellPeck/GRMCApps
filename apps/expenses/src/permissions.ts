export interface PermissionRow {
  email: string;
  name: string;
  can_submit: boolean;
  can_submit_for_others: boolean;
  can_edit_own: boolean;
  can_approve: boolean;
  can_manage: boolean;
  is_admin: boolean;
  default_approver_email: string | null;
}

// What the rest of the app asks. Deliberately a different shape from the stored
// row: implications are resolved once, here, so no caller has to remember that
// manage includes approve.
export interface Permissions {
  submit: boolean;
  submitForOthers: boolean;
  approve: boolean;
  manage: boolean;
  admin: boolean;
  defaultApprover: string | null;
}

export const NO_PERMISSIONS: Permissions = {
  submit: false,
  submitForOthers: false,
  approve: false,
  manage: false,
  admin: false,
  defaultApprover: null,
};

export const LAST_ADMIN_ERROR =
  "This is the last administrator for Expenses. Grant admin to someone else first.";

export function effectivePermissions(row: PermissionRow | null): Permissions {
  if (!row) return NO_PERMISSIONS;
  return {
    submit: row.can_submit,
    submitForOthers: row.can_submit_for_others,
    // can_edit_own is deliberately not mapped: revising your own undecided
    // request is a right that comes with submitting it, not a grant. The column
    // stays on app_users so no data is destroyed, but nothing reads it.
    // manage implies approve — resolved here so no route has to check both.
    approve: row.can_approve || row.can_manage,
    manage: row.can_manage,
    // admin implies nothing, matching the hub's admin flag.
    admin: row.is_admin,
    defaultApprover: row.default_approver_email,
  };
}

export type PermissionChange =
  | { type: "demote"; email: string }
  | { type: "remove"; email: string };

export type GuardResult = { ok: true } | { ok: false; error: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Mirrors the hub's last-active-admin rule so the two cannot drift.
export function checkPermissionChange(
  rows: PermissionRow[],
  change: PermissionChange
): GuardResult {
  const target = rows.find((r) => same(r.email, change.email));
  if (!target) return { ok: false, error: "No permissions found for that user." };
  if (!target.is_admin) return { ok: true };
  if (rows.filter((r) => r.is_admin).length <= 1) return { ok: false, error: LAST_ADMIN_ERROR };
  return { ok: true };
}
