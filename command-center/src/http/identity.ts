// The identity check: proof to a client that the server answering on a port is the Command
// Center holding this database's api token, given before the client sends that token anywhere.
//
// The updater's health check (update/health.ts) needs it, as the desktop shell did before it was
// removed. A client that reads the api token from the file next to the database and talks to
// whatever answers on the port must not send the token as a bearer credential first and take any
// 2xx as the daemon: another local account that bound the port while the daemon was stopped would
// be handed the token. So the client sends a fresh random challenge, the daemon answers with an
// HMAC of it keyed with the token, and the client computes the same. Only a process that knows
// the token can answer, and the answer discloses nothing: an HMAC of a chosen message does not
// give the key away.
//
// The proof also covers the port the request arrived on, so a process on the expected port cannot
// forward the challenge to a real daemon listening elsewhere and hand back its answer.
//
// The vector in identity.test.ts pins the proof byte for byte, so an older updater still verifies
// a newer daemon.
import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError, sendJson } from './errors.ts';
import type { Router } from './router.ts';

export const IDENTITY_PATH = '/api/identity';

/** A fixed protocol constant kept from before the Constellation to Polaris rename, so a previous release's
 *  updater (update/health.ts) still verifies the daemon. Do not change it. */
const IDENTITY_DOMAIN = 'constellation-identity';

/** The message the proof is an HMAC of: a fixed label, the listening port, and the challenge. */
export function identityProof(apiToken: string, port: number, challenge: string): string {
  return createHmac('sha256', apiToken).update(`${IDENTITY_DOMAIN}\n${port}\n${challenge}`).digest('hex');
}

/** 32 to 128 hex characters: 16 to 64 random bytes. Anything else is not a challenge. */
const CHALLENGE_RE = /^[0-9a-f]{32,128}$/;

export function registerIdentityRoute(router: Router, apiToken: string): void {
  router.add('GET', IDENTITY_PATH, (ctx) => {
    const challenge = ctx.url.searchParams.get('challenge') ?? '';
    if (!CHALLENGE_RE.test(challenge)) throw new HttpError(400, 'BadRequest', 'challenge must be 32 to 128 lowercase hex characters');
    sendJson(ctx.res, 200, { proof: identityProof(apiToken, localPort(ctx.req), challenge) });
  });
}

function localPort(req: IncomingMessage): number {
  return req.socket.localPort ?? 0;
}
