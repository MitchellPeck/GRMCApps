import type { HubUser } from "../apps/registry";

export type AdminRequestDecision =
  | { ok: true }
  | { ok: false; status: number; error: string };

// Pure: who may touch user management, and from where. Kept out of the Fastify
// hook so every branch is testable without booting a server or a database.
//
// The Origin check applies to mutations only. The session cookie is
// SameSite=Lax, which already stops a cross-site browser POST from carrying it;
// this is belt-and-braces on the one surface that hands out access. An absent
// Origin is allowed, because non-browser callers send none.
export function decideAdminRequest(
  user: HubUser | null,
  method: string,
  origin: string,
  publicUrl: string
): AdminRequestDecision {
  if (!user) return { ok: false, status: 403, error: "Sign in first." };
  if (!user.active || !user.is_admin) {
    return { ok: false, status: 403, error: "You do not have access to user management." };
  }

  const isRead = method === "GET" || method === "HEAD";
  if (!isRead && origin && origin !== publicUrl) {
    return { ok: false, status: 403, error: "Bad origin." };
  }

  return { ok: true };
}
