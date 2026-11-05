export interface PermissionRow {
  email: string;
  name: string;
  can_submit: boolean;
  can_submit_for_others: boolean;
  can_edit_own: boolean;
  can_approve: boolean;
  can_manage: boolean;
  can_pay: boolean;
  can_audit: boolean;
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
  // The office: prepares requests for others, corrects approved ones, voids,
  // keeps the charge codes. Does NOT approve — that is a separate grant, so the
  // person who keys and pays the money is not also the one who signs it off.
  manage: boolean;
  pay: boolean;
  // Read-only: sees every request and report, changes nothing. For the CPA.
  audit: boolean;
  admin: boolean;
  defaultApprover: string | null;
}

export const NO_PERMISSIONS: Permissions = {
  submit: false,
  submitForOthers: false,
  approve: false,
  manage: false,
  pay: false,
  audit: false,
  admin: false,
  defaultApprover: null,
};

// Derived, so no caller has to remember the combinations.
// An approver who is also the office may decide any request, not just those
// assigned to them — that is how the old "manage" behaved.
// approvesAny implies seesAll (it needs manage), so visibility checks need only
// seesAll. Reports go to the same people who see every request.
export const approvesAny = (p: Permissions) => p.approve && p.manage;
export const seesAll = (p: Permissions) => p.manage || p.pay || p.audit;
export const seesReports = seesAll;
export const isMember = (p: Permissions) =>
  p.submit || p.approve || p.manage || p.pay || p.audit || p.admin;

export type RoleName = "submitter" | "approver" | "assistant" | "accountant";
export type RoleFlags = Pick<
  PermissionRow,
  "can_submit" | "can_submit_for_others" | "can_approve" | "can_manage" | "can_pay" | "can_audit"
>;

// The four people the app is for. Admin is left out on purpose: it is a
// separate grant for whoever keeps the settings.
export const ROLE_PRESETS: Record<RoleName, RoleFlags> = {
  submitter: { can_submit: true, can_submit_for_others: false, can_approve: false, can_manage: false, can_pay: false, can_audit: false },
  approver: { can_submit: true, can_submit_for_others: false, can_approve: true, can_manage: false, can_pay: false, can_audit: false },
  assistant: { can_submit: true, can_submit_for_others: true, can_approve: false, can_manage: true, can_pay: true, can_audit: false },
  accountant: { can_submit: false, can_submit_for_others: false, can_approve: false, can_manage: false, can_pay: false, can_audit: true },
};

export function roleOf(row: RoleFlags): RoleName | null {
  for (const [name, flags] of Object.entries(ROLE_PRESETS) as [RoleName, RoleFlags][]) {
    if ((Object.keys(flags) as (keyof RoleFlags)[]).every((k) => !!row[k] === flags[k])) return name;
  }
  return null;
}

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
    approve: row.can_approve,
    manage: row.can_manage,
    pay: row.can_pay,
    audit: row.can_audit,
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
