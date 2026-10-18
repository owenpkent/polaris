// Error envelope shared by every /api and /mcp response: { error: { code, message } }. Never
// includes a stack trace, and never an unknown error's message (it is logged, not sent).
import type { ServerResponse } from 'node:http';
import { NotFoundError, ValidationError } from '../core/index.ts';

/** An error with an explicit HTTP status/code, for cases core's NotFoundError/ValidationError don't cover (401, 405, 409, 413). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorToPayload(e: unknown): { status: number; code: string; message: string } {
  if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof NotFoundError) return { status: 404, code: 'NotFoundError', message: e.message };
  if (e instanceof ValidationError) return { status: 400, code: 'ValidationError', message: e.message };
  // The real message goes to the log only; the client gets a fixed string.
  console.error(`internal error: ${e instanceof Error ? e.message : String(e)}`);
  return { status: 500, code: 'InternalError', message: 'Internal error' };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export function sendNoContent(res: ServerResponse, status = 204): void {
  res.statusCode = status;
  res.end();
}
