import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { NotFoundError, ValidationError } from '../core/index.ts';
import { errorToPayload, HttpError, sendError, sendJson, sendNoContent } from './errors.ts';

test('HttpError carries the status, code, and message it was built with', () => {
  const e = new HttpError(409, 'Conflict', 'already running');
  assert.equal(e.status, 409);
  assert.equal(e.code, 'Conflict');
  assert.equal(e.message, 'already running');
  assert.ok(e instanceof Error);
});

test('errorToPayload maps HttpError through unchanged', () => {
  const e = new HttpError(413, 'PayloadTooLarge', 'too big');
  assert.deepEqual(errorToPayload(e), { status: 413, code: 'PayloadTooLarge', message: 'too big' });
});

test('errorToPayload maps core NotFoundError to 404', () => {
  const e = new NotFoundError('task not found: x');
  assert.deepEqual(errorToPayload(e), { status: 404, code: 'NotFoundError', message: 'task not found: x' });
});

test('errorToPayload maps core ValidationError to 400', () => {
  const e = new ValidationError('title is required');
  assert.deepEqual(errorToPayload(e), { status: 400, code: 'ValidationError', message: 'title is required' });
});

test('errorToPayload maps an ordinary Error to a 500 InternalError, keeping its message', () => {
  const e = new Error('boom');
  assert.deepEqual(errorToPayload(e), { status: 500, code: 'InternalError', message: 'boom' });
});

test('errorToPayload maps a thrown non-Error value to a generic 500 message', () => {
  assert.deepEqual(errorToPayload('a plain string'), { status: 500, code: 'InternalError', message: 'internal error' });
  assert.deepEqual(errorToPayload(undefined), { status: 500, code: 'InternalError', message: 'internal error' });
  assert.deepEqual(errorToPayload({ some: 'object' }), { status: 500, code: 'InternalError', message: 'internal error' });
});

test('errorToPayload never leaks a stack trace', () => {
  const e = new Error('boom');
  const payload = errorToPayload(e);
  assert.deepEqual(Object.keys(payload).sort(), ['code', 'message', 'status']);
});

// sendJson/sendError/sendNoContent write through a real ServerResponse (node:http requires one;
// it cannot be constructed standalone, so each test spins up a throwaway server for one request).
async function withResponse(fn: (res: ServerResponse) => void): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const server = createServer((_req, res) => fn(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.text();
    const headers: Record<string, string | string[] | undefined> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('sendJson sets status, content-type, and a JSON body', async () => {
  const { status, headers, body } = await withResponse((res) => sendJson(res, 201, { ok: true, n: 1 }));
  assert.equal(status, 201);
  assert.match(String(headers['content-type']), /application\/json/);
  assert.deepEqual(JSON.parse(body), { ok: true, n: 1 });
});

test('sendJson does not touch status/headers if headers were already sent', async () => {
  const { status, body } = await withResponse((res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.flushHeaders();
    sendJson(res, 500, { ignored: true });
  });
  // headersSent was true, so sendJson only calls res.end(JSON.stringify(...)); the status stays 200.
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), { ignored: true });
});

test('sendError wraps code/message in the shared { error: { code, message } } envelope', async () => {
  const { status, body } = await withResponse((res) => sendError(res, 400, 'ValidationError', 'title is required'));
  assert.equal(status, 400);
  assert.deepEqual(JSON.parse(body), { error: { code: 'ValidationError', message: 'title is required' } });
});

test('sendNoContent defaults to 204 and sends no body', async () => {
  const { status, body } = await withResponse((res) => sendNoContent(res));
  assert.equal(status, 204);
  assert.equal(body, '');
});

test('sendNoContent accepts an explicit status', async () => {
  const { status } = await withResponse((res) => sendNoContent(res, 202));
  assert.equal(status, 202);
});
