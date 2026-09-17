export interface AdminCandidate {
  id: string;
  is_admin: boolean;
  active: boolean;
}

export type AdminChange =
  | { type: "demote"; userId: string }
  | { type: "disable"; userId: string }
  | { type: "delete"; userId: string };

export type GuardResult = { ok: true } | { ok: false; error: string };

export const LAST_ADMIN_ERROR =
  "This is the last active administrator. Promote another administrator first.";

// All three ways of removing an administrator collapse to one rule: you may not
// remove the last account that can still reach the Users screen. Kept as a
// single tested function so demote, disable and delete cannot drift apart.
export function checkAdminChange(users: AdminCandidate[], change: AdminChange): GuardResult {
  const target = users.find((u) => u.id === change.userId);
  if (!target) return { ok: false, error: "User not found." };

  // Only an active admin is holding the quorum; anyone else is free to change.
  if (!(target.is_admin && target.active)) return { ok: true };

  const activeAdmins = users.filter((u) => u.is_admin && u.active);
  if (activeAdmins.length <= 1) return { ok: false, error: LAST_ADMIN_ERROR };
  return { ok: true };
}
