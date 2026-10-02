// GitHub webhook receiver. Verifies the HMAC signature, responds fast (202), then re-fetches
// and re-applies the same rulebook as the poller for exactly the item the event names.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App } from '../../app.ts';
import { resolveGithubAuth } from './auth.ts';
import { GithubClient } from './client.ts';
import { isSyncIssuesEnabled } from './repoSettings.ts';
import { mapProjectsToRepos } from './mapping.ts';
import { refreshItem } from './sync.ts';

export interface WebhookOptions {
  secret: string;
  token?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Reject bodies larger than this many bytes (default: GitHub's own webhook payload limit). */
  maxBodyBytes?: number;
}

/** GitHub's documented maximum webhook payload size. */
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

const HANDLED_EVENTS = new Set(['issues', 'pull_request', 'pull_request_review', 'issue_comment', 'check_suite']);

/** Raised by readBody when the request body exceeds maxBodyBytes. */
export class PayloadTooLargeError extends Error {}

/**
 * Buffers the request body, rejecting once it exceeds maxBytes. This is the only route on this
 * server and it is unauthenticated until the body is fully read and its signature checked, so
 * without a cap an attacker can make it buffer an unbounded amount of data in memory before any
 * HMAC work (or even the ability to reject it) happens. Once the cap is hit we stop reading
 * (pause(), so no more of the body piles up in memory) but do not destroy the socket here: req
 * and res share one socket, and destroying it before the 413 response is written risks the
 * response never reaching the client. The caller destroys the request once that response has
 * actually been flushed (see createWebhookHandler).
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (c: Buffer) => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) {
        settled = true;
        req.pause();
        reject(new PayloadTooLargeError(`webhook body exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!settled) resolvePromise(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!settled) reject(e);
    });
  });
}

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(header, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

interface WebhookIssueRef { number: number }
interface WebhookPayload {
  issue?: WebhookIssueRef;
  pull_request?: WebhookIssueRef;
  repository?: { owner: { login: string }; name: string };
  check_suite?: { pull_requests?: WebhookIssueRef[] };
}

function affectedNumbers(event: string, payload: WebhookPayload): number[] {
  if (event === 'check_suite') return (payload.check_suite?.pull_requests ?? []).map((p) => p.number);
  if (payload.pull_request) return [payload.pull_request.number];
  if (payload.issue) return [payload.issue.number];
  return [];
}

/** Returns a node:http request listener. Mount it on any path; there is no routing here. */
export function createWebhookHandler(app: App, opts: WebhookOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const log = opts.log ?? (() => {});
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return (req, res) => {
    void (async () => {
      let body: Buffer;
      try {
        body = await readBody(req, maxBodyBytes);
      } catch (e) {
        if (e instanceof PayloadTooLargeError) {
          res.statusCode = 413;
          // Destroy only once the response is actually flushed: req and res share a socket, and
          // destroying it any earlier risks the 413 never reaching the client.
          res.once('finish', () => req.destroy());
          res.end('payload too large');
        } else {
          res.statusCode = 400;
          res.end('bad request');
        }
        return;
      }
      const signature = req.headers['x-hub-signature-256'];
      if (!verifySignature(opts.secret, body, Array.isArray(signature) ? signature[0] : signature)) {
        res.statusCode = 401;
        res.end('invalid signature');
        return;
      }
      const eventHeader = req.headers['x-github-event'];
      const event = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
      if (event === 'ping') {
        res.statusCode = 200;
        res.end('pong');
        return;
      }
      if (!event || !HANDLED_EVENTS.has(event)) {
        res.statusCode = 202;
        res.end('ignored');
        return;
      }
      let payload: WebhookPayload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        res.statusCode = 400;
        res.end('invalid json');
        return;
      }
      // Respond immediately; processing happens after the response is sent.
      res.statusCode = 202;
      res.end('accepted');
      try {
        await processEvent(app, event, payload, opts);
      } catch (e) {
        log(`webhook processing failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })().catch((e) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('error');
      }
      log(`webhook handler error: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
}

async function processEvent(app: App, event: string, payload: WebhookPayload, opts: WebhookOptions): Promise<void> {
  const owner = payload.repository?.owner.login;
  const repo = payload.repository?.name;
  const numbers = affectedNumbers(event, payload);
  if (!owner || !repo || numbers.length === 0) return;

  // The owner can switch issue sync off per repo, and every stage of the poller honours it. The
  // webhook is just a faster poller, so it honours it too -- otherwise a repo the owner turned off
  // still produces tasks, and the poller's sweep skips that repo so they could never be
  // cleaned up either.
  if (!isSyncIssuesEnabled(app.store, `${owner}/${repo}`)) return;

  const token = opts.token ?? await resolveGithubAuth();
  const client = new GithubClient({ token, store: app.store, fetchImpl: opts.fetchImpl, log: opts.log });
  const viewerLogin = await client.viewer();
  const mappings = await mapProjectsToRepos(app.store.listProjects());
  const fullName = `${owner}/${repo}`;
  const projectId = mappings.find((m) => m.fullName.toLowerCase() === fullName.toLowerCase())?.projectId ?? null;

  for (const number of numbers) {
    await refreshItem(app.store, client, { fullName, owner, repo, number, projectId, viewerLogin });
  }
}
