import type { FastifyRequest } from 'fastify';

/**
 * Who is making this request, if anyone says so.
 *
 * There is no login. Identity comes from headers an SSO reverse proxy sets
 * (oauth2-proxy, Pomerium and friends all emit `x-forwarded-user` /
 * `x-forwarded-email`), or from the CLI's `x-golinks-user`. A proxy that sets
 * these must also strip inbound copies, or anyone can claim to be anyone —
 * which is why ownership is treated as a courtesy guard, not a security one.
 */
const IDENTITY_HEADERS = ['x-golinks-user', 'x-forwarded-user', 'x-forwarded-email'] as const;
const MAX_IDENTITY_LENGTH = 120;

export const actorFrom = (request: FastifyRequest): string | null => {
  for (const header of IDENTITY_HEADERS) {
    const raw = request.headers[header];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value) return value.slice(0, MAX_IDENTITY_LENGTH);
  }
  return null;
};
