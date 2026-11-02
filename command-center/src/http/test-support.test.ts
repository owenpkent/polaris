import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchRefusesPort, listenForFetch } from './test-support.ts';

test('the test server never listens on a port fetch refuses', async () => {
  // The Fetch Standard's bad ports, which undici turns into "fetch failed: bad port".
  for (const port of [1, 25, 6000, 6667, 10080]) assert.equal(fetchRefusesPort(port), true, String(port));
  for (const port of [80, 443, 1024, 8788, 49152]) assert.equal(fetchRefusesPort(port), false, String(port));

  const server = createServer((_req, res) => res.end('ok'));
  try {
    const port = await listenForFetch(server);
    assert.ok(port > 0 && !fetchRefusesPort(port));
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await res.text(), 'ok');
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
