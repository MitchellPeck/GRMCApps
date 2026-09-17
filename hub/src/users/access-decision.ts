export interface AccessContext {
  userActive: boolean;
  appEnabled: boolean;
  hasGrant: boolean;
}

export type AccessDenial = "app_disabled" | "user_disabled" | "no_grant";

export type AccessDecision = { allowed: true } | { allowed: false; reason: AccessDenial };

// Pure, and deliberately WITHOUT an `isAdmin` field: "admin" grants user
// management only, so there is structurally no way for this function to let an
// administrator into an app they were not granted.
export function decideAccess(ctx: AccessContext): AccessDecision {
  if (!ctx.appEnabled) return { allowed: false, reason: "app_disabled" };
  if (!ctx.userActive) return { allowed: false, reason: "user_disabled" };
  if (!ctx.hasGrant) return { allowed: false, reason: "no_grant" };
  return { allowed: true };
}

// Replaces the hardcoded "user" that /auth/verify used to emit. Apps read this
// from X-Auth-Roles, which Traefik re-adds only from the auth response.
export function roleHeader(isAdmin: boolean): "admin" | "user" {
  return isAdmin ? "admin" : "user";
}
