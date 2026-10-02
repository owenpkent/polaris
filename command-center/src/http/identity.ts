// The identity check: proof to a client that the server answering on a port is the Command
// Center holding this database's api token, given before the client sends that token anywhere.
//
// The desktop shell (desktop/src-tauri/src/main.rs) needs it. It reads the api token from the
// file next to the database and opens the dashboard on whatever answers on the port. Before this
// check it sent the token as a bearer credential to that process first and took any 2xx as the
// daemon, so another local account that bound the port while the daemon was stopped would have
// been handed the token and then the whole dashboard to serve. Now the shell sends a fresh random
// challenge, the daemon answers with an HMAC of it keyed with the token, and the shell computes
// the same. Only a process that knows the token can answer, and the answer discloses nothing: an
// HMAC of a chosen message does not give the key away.
//
// The proof also covers the port the request arrived on, so a process on the expected port cannot
// forward the challenge to a real daemon listening elsewhere and hand back its answer.
//
// The Rust side of this is `identity_proof` in main.rs. The two must agree byte for byte; the
// vector in identity.test.ts is the one both test against.
import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError, sendJson } from './errors.ts';
import type { Router } from './router.ts';

export const IDENTITY_PATH = '/api/identity';

/** The message the proof is an HMAC of: a fixed label, the listening port, and the challenge. */
export function identityProof(apiToken: string, port: number, challenge: string): string {
  return createHmac('sha256', apiToken).update(`constellation-identity\n${port}\n${challenge}`).digest('hex');
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
