import { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db";
import { getIdentity } from "./identity";
import { Permissions, effectivePermissions } from "./permissions";
import { getPermissionRow } from "./app-users";

declare module "fastify" {
  interface FastifyRequest {
    perms?: Permissions;
  }
}

// Cached on the request: several handlers ask for it, and it is one query.
export async function loadPermissions(req: FastifyRequest): Promise<Permissions> {
  if (req.perms) return req.perms;
  const id = getIdentity(req);
  req.perms = effectivePermissions(await getPermissionRow(pool, id.email));
  return req.perms;
}

// Server-side enforcement. The UI also hides what a user cannot do, but that is
// cosmetic — this is the check that matters.
export function requirePermission(name: keyof Permissions) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const perms = await loadPermissions(req);
    if (!perms[name]) {
      return reply.code(403).send({
        ok: false,
        error: "You do not have permission to do that in Expenses.",
      });
    }
  };
}
