import { FastifyRequest } from "fastify";

export interface Identity {
  email: string;
  name: string;
}

// Identity headers are injected by Traefik forwardAuth (from the hub). The
// admin host is fully gated, so these are present on every real request.
//
// The /player and /api/player/* routes are DELIBERATELY outside that gate — a
// TV cannot complete a Google sign-in — and carry a screen token instead. See
// routes/player.ts.
export function getIdentity(req: FastifyRequest): Identity {
  return {
    email: (req.headers["x-auth-email"] as string) ?? "",
    name: (req.headers["x-auth-name"] as string) ?? "",
  };
}
