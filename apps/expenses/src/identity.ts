import { FastifyRequest } from "fastify";

export interface Identity {
  email: string;
  name: string;
}

// Identity headers are injected by Traefik forwardAuth (from the hub). The
// host is fully gated, so these are present on every real request.
export function getIdentity(req: FastifyRequest): Identity {
  return {
    email: (req.headers["x-auth-email"] as string) ?? "",
    name: (req.headers["x-auth-name"] as string) ?? "",
  };
}
