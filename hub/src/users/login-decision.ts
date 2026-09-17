// One user row as the login path needs it. Shared by the access check and the
// admin routes so the shape does not drift.
export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  // Null until the invited account's first successful Google sign-in.
  google_sub: string | null;
  active: boolean;
  is_admin: boolean;
}

export interface LoginClaims {
  sub: string;
  email: string;
  name?: string | null;
}

export type LoginDenial = "not_provisioned" | "disabled" | "email_bound_elsewhere";

export type LoginDecision =
  | { kind: "returning"; userId: string }
  | { kind: "bind"; userId: string }
  | { kind: "deny"; reason: LoginDenial };

// Pure: the entire invite-only rule, with no database or Google round trip.
// `bySub` is the lookup on google_sub; `byEmail` the fallback lookup on
// lower(email), which is what an administrator actually typed when inviting.
export function decideLogin(
  bySub: UserRecord | null,
  byEmail: UserRecord | null,
  claims: LoginClaims
): LoginDecision {
  if (bySub) {
    if (!bySub.active) return { kind: "deny", reason: "disabled" };
    return { kind: "returning", userId: bySub.id };
  }

  // No account carries this Google identity, so the only way in is an
  // invitation waiting on this address.
  if (!byEmail) return { kind: "deny", reason: "not_provisioned" };

  // The address is already claimed by a different Google account. Checked
  // before `active` so the warning log names the real problem.
  if (byEmail.google_sub !== null && byEmail.google_sub !== claims.sub) {
    return { kind: "deny", reason: "email_bound_elsewhere" };
  }

  if (!byEmail.active) return { kind: "deny", reason: "disabled" };
  return { kind: "bind", userId: byEmail.id };
}
