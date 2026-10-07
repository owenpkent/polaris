// The health check after a restart (docs/update-proposal.md, section 1, step 8). "Something
// answers on the port" is not enough: the daemon must first prove it holds this install's api
// token, through the same challenge the desktop shell uses (http/identity.ts), and only then is
// the token sent as a bearer credential to GET /api/health, which must say ok and name the
// version that was just installed. The token is read by the caller from the file next to the
// database and never printed.
import { randomBytes } from 'node:crypto';
import { IDENTITY_PATH, identityProof } from '../http/identity.ts';

export interface HealthCheck {
  port: number;
  apiToken: string;
  expectedVersion: string;
}

export interface HealthDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type HealthOutcome = { ok: true } | { ok: false; reason: string };

/** One round: identity, then health. A failure says which. */
export async function checkHealthOnce(check: HealthCheck, fetchFn: typeof fetch): Promise<HealthOutcome> {
  const base = `http://127.0.0.1:${check.port}`;
  const challenge = randomBytes(32).toString('hex');
  let identity: Response;
  try {
    identity = await fetchFn(`${base}${IDENTITY_PATH}?challenge=${challenge}`);
  } catch (e) {
    return { ok: false, reason: `no answer on port ${check.port} (${e instanceof Error ? e.message : String(e)})` };
  }
  if (identity.status !== 200) return { ok: false, reason: `GET ${IDENTITY_PATH} answered ${identity.status}` };
  const proof = (await identity.json().catch(() => ({}))) as { proof?: unknown };
  if (proof.proof !== identityProof(check.apiToken, check.port, challenge)) {
    return { ok: false, reason: `the process on port ${check.port} does not hold this install's api token` };
  }
  let health: Response;
  try {
    health = await fetchFn(`${base}/api/health`, { headers: { Authorization: `Bearer ${check.apiToken}` } });
  } catch (e) {
    return { ok: false, reason: `GET /api/health failed (${e instanceof Error ? e.message : String(e)})` };
  }
  if (health.status !== 200) return { ok: false, reason: `GET /api/health answered ${health.status}` };
  const body = (await health.json().catch(() => ({}))) as { ok?: unknown; version?: unknown };
  if (body.ok !== true) return { ok: false, reason: 'GET /api/health did not say ok' };
  if (body.version !== check.expectedVersion) return { ok: false, reason: `the daemon reports version ${String(body.version)}, expected ${check.expectedVersion}` };
  return { ok: true };
}

/** Repeat the check until it passes or the time runs out; a daemon takes a moment to come up. The
 *  failure carries the last reason seen. */
export async function waitForHealthy(check: HealthCheck, timeoutMs: number, deps: HealthDeps): Promise<HealthOutcome> {
  const deadline = deps.now() + timeoutMs;
  let last: HealthOutcome = { ok: false, reason: 'not checked' };
  for (;;) {
    last = await checkHealthOnce(check, deps.fetch);
    if (last.ok || deps.now() >= deadline) return last;
    await deps.sleep(500);
  }
}
