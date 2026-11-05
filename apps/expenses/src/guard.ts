import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type FastifyInstanceAddHook = FastifyInstance["addHook"];
import { pool } from "./db";
import { getIdentity } from "./identity";
import { Permissions, effectivePermissions, isMember } from "./permissions";
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
export function requirePermission(name: keyof Permissions | ((p: Permissions) => boolean)) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const perms = await loadPermissions(req);
    if (!(typeof name === "function" ? name(perms) : perms[name])) {
      return reply.code(403).send({
        ok: false,
        error: "You do not have permission to do that in Expenses.",
      });
    }
  };
}

// Anyone the Expenses admin has granted anything at all. Being let into the
// app by the hub is not enough to read every request or spend Claude credit
// on extraction.
export async function requireMember(req: FastifyRequest, reply: FastifyReply) {
  const p = await loadPermissions(req);
  if (!isMember(p)) {
    return reply.code(403).send({
      ok: false,
      error: "You have not been given access to Expenses yet. Ask an Expenses administrator.",
    });
  }
}

// Route ids are numbers. Anything else is a 400 here rather than a 500 from
// Postgres failing to cast it.
export function rejectBadIds(app: { addHook: FastifyInstanceAddHook }): void {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const params = (req.params ?? {}) as Record<string, string>;
    for (const key of ["id", "rid"]) {
      if (params[key] !== undefined && !/^\d{1,15}$/.test(params[key])) {
        return reply.code(400).send({ ok: false, error: "Not a valid id." });
      }
    }
  });
}
