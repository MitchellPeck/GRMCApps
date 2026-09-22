export interface PermissionRow {
  email: string;
  name: string;
  can_upload: boolean;
  can_schedule: boolean;
  can_manage: boolean;
  is_admin: boolean;
}

// What the rest of the app asks. Deliberately a different shape from the stored
// row: the implications are resolved once, here, so no route has to remember
// that scheduling something you cannot upload to would be useless.
export interface Permissions {
  upload: boolean;
  schedule: boolean;
  manage: boolean;
  admin: boolean;
}

export const NO_PERMISSIONS: Permissions = {
  upload: false,
  schedule: false,
  manage: false,
  admin: false,
};

export const LAST_ADMIN_ERROR =
  "This is the last administrator for Narthex TV. Grant admin to someone else first.";

export function effectivePermissions(row: PermissionRow | null): Permissions {
  if (!row) return NO_PERMISSIONS;
  const manage = row.can_manage;
  const schedule = row.can_schedule || manage;
  return {
    // Anyone who may schedule may upload — a playlist you cannot put media in
    // is not a grant, it is a dead end.
    upload: row.can_upload || schedule,
    schedule,
    manage,
    // admin implies nothing else, matching the hub's admin flag: it grants the
    // permissions + settings screens, not the right to put something on the TV.
    admin: row.is_admin,
  };
}

export type PermissionChange = { type: "demote" | "remove"; email: string };
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
