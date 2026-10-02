import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.ts';
import { readJsonBody } from './body.ts';

/** A push-based Readable standing in for an IncomingMessage: readJsonBody only ever touches
 * req.headers and the data/end/error events, both of which a plain Readable provides. */
function fakeRequest(headers: Record<string, string> = {}): IncomingMessage {
  const stream = new Readable({ read() {} });
  Object.assign(stream, { headers });
  return stream as unknown as IncomingMessage;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('parses a valid JSON object body', async () => {
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, 1024);
  req.push(Buffer.from(JSON.stringify({ title: 'hello', n: 1 })));
  req.push(null);
  assert.deepEqual(await promise, { title: 'hello', n: 1 });
});

test('parses a valid JSON array/primitive body (JSON.parse accepts any valid JSON, not just objects)', async () => {
  const req1 = fakeRequest({ 'content-type': 'application/json' });
  const p1 = readJsonBody(req1, 1024);
  req1.push(Buffer.from('[1,2,3]'));
  req1.push(null);
  assert.deepEqual(await p1, [1, 2, 3]);

  const req2 = fakeRequest({ 'content-type': 'application/json' });
  const p2 = readJsonBody(req2, 1024);
  req2.push(Buffer.from('null'));
  req2.push(null);
  assert.equal(await p2, null);
});

test('an empty body resolves to undefined by default', async () => {
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, 1024);
  req.push(null);
  assert.equal(await promise, undefined);
});

test('an empty body resolves to undefined even with no content-type header at all', async () => {
  const req = fakeRequest();
  const promise = readJsonBody(req, 1024);
  req.push(null);
  assert.equal(await promise, undefined);
});

test('allowEmpty:false rejects an empty body with 400 BadRequest', async () => {
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, 1024, { allowEmpty: false });
  req.push(null);
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 400);
    assert.equal(e.code, 'BadRequest');
    assert.match(e.message, /body is required/);
    return true;
  });
});

test('invalid JSON with a correct content-type rejects with 400 BadRequest', async () => {
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, 1024);
  req.push(Buffer.from('{not valid json'));
  req.push(null);
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 400);
    assert.equal(e.code, 'BadRequest');
    assert.match(e.message, /invalid JSON body/);
    return true;
  });
});

test('a non-empty body with the wrong content-type is rejected before JSON is even parsed', async () => {
  const req = fakeRequest({ 'content-type': 'text/plain' });
  const promise = readJsonBody(req, 1024);
  req.push(Buffer.from(JSON.stringify({ ok: true })));
  req.push(null);
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 400);
    assert.equal(e.code, 'BadRequest');
    assert.match(e.message, /Content-Type must be application\/json/);
    return true;
  });
});

test('a non-empty body with no content-type header at all is rejected', async () => {
  const req = fakeRequest();
  const promise = readJsonBody(req, 1024);
  req.push(Buffer.from('{}'));
  req.push(null);
  await assert.rejects(promise, /Content-Type must be application\/json/);
});

test('content-type matching is case-insensitive and tolerates a charset parameter', async () => {
  const req = fakeRequest({ 'content-type': 'Application/JSON; charset=utf-8' });
  const promise = readJsonBody(req, 1024);
  req.push(Buffer.from('{"a":1}'));
  req.push(null);
  assert.deepEqual(await promise, { a: 1 });
});

test('a body of exactly maxBytes is accepted (the cap rejects only when total exceeds it)', async () => {
  const body = JSON.stringify({ x: 1 });
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, Buffer.byteLength(body));
  req.push(Buffer.from(body));
  req.push(null);
  assert.deepEqual(await promise, { x: 1 });
});

test('a body one byte over maxBytes is rejected with 413 PayloadTooLarge', async () => {
  const body = JSON.stringify({ x: 1 });
  const req = fakeRequest({ 'content-type': 'application/json' });
  const maxBytes = Buffer.byteLength(body) - 1;
  const promise = readJsonBody(req, maxBytes);
  req.push(Buffer.from(body));
  req.push(null);
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 413);
    assert.equal(e.code, 'PayloadTooLarge');
    assert.match(e.message, new RegExp(`exceeds ${maxBytes} bytes`));
    return true;
  });
});

test('the cap is enforced across multiple chunks, not just a single chunk', async () => {
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, 10);
  // Attach a handler immediately: the awaits below let the rejection happen before
  // assert.rejects attaches its own, which node would otherwise flag as unhandled.
  promise.catch(() => {});
  // Neither chunk alone exceeds 10 bytes, but together they do.
  req.push(Buffer.from('123456')); // 6 bytes
  await tick();
  req.push(Buffer.from('78901')); // + 5 = 11 bytes, crosses the cap
  await tick();
  req.push(null);
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 413);
    return true;
  });
});

test('maxBytes of 0 rejects any non-empty body', async () => {
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, 0);
  req.push(Buffer.from('{}'));
  req.push(null);
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 413);
    return true;
  });
});

test('an error emitted on the request before any data rejects the promise with that error', async () => {
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, 1024);
  const boom = new Error('socket hang up');
  req.emit('error', boom);
  await assert.rejects(promise, /socket hang up/);
});

test('an error emitted after the cap already rejected does not surface a second rejection', async () => {
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, 2);
  promise.catch(() => {});
  req.push(Buffer.from('too big'));
  await tick();
  // The stream errors after tooLarge is already set; readJsonBody's error handler checks
  // `!tooLarge` before rejecting again, so the original 413 is what the caller observes.
  req.emit('error', new Error('late socket error'));
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 413);
    return true;
  });
});

test('hostile input: a body containing only whitespace is non-empty and must still be valid JSON', async () => {
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, 1024);
  req.push(Buffer.from('   '));
  req.push(null);
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 400);
    assert.equal(e.code, 'BadRequest');
    return true;
  });
});

test('hostile input: deeply nested JSON parses fine as long as it is under the byte cap', async () => {
  let value: unknown = 1;
  for (let i = 0; i < 50; i++) value = { nested: value };
  const body = JSON.stringify(value);
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, Buffer.byteLength(body) + 10);
  req.push(Buffer.from(body));
  req.push(null);
  const parsed = await promise;
  assert.equal(typeof parsed, 'object');
});

test('multi-byte UTF-8 characters are counted by byte length, not character length', async () => {
  // Each of these characters is a multi-byte UTF-8 sequence, so byte length != string length.
  const value = { title: 'déjà vu 😀' };
  const body = JSON.stringify(value);
  const byteLength = Buffer.byteLength(body, 'utf8');
  assert.ok(byteLength > body.length);
  const req = fakeRequest({ 'content-type': 'application/json' });
  const promise = readJsonBody(req, byteLength);
  req.push(Buffer.from(body, 'utf8'));
  req.push(null);
  assert.deepEqual(await promise, value);
});
