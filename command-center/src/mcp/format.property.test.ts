// Property tests for how a thread post is rendered for an assistant (mcp/format.ts, postBlock).
// The promise: the body sits inside a backtick fence that nothing in the body can close, so a
// third party's text cannot step out of the data block and read as the tool's own prose.
//
// The harness is in dev/property.ts. Replay a failure with the seed and path it prints:
//   CC_PROPERTY_SEED=<seed> CC_PROPERTY_PATH=<path> node --test src/mcp/format.property.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { check, anyText } from '../dev/property.ts';
import type { Post } from '../core/index.ts';
import { postBlock } from './format.ts';

const post = (body: string): Post => ({
  id: 'p1', threadId: 't1', parentPostId: null, author: 'agent', authorName: null, type: 'claim', body,
  confidence: null, status: null, refs: [], untrustedText: true, judgedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
});
const bodies = fc.oneof(anyText(), fc.array(fc.constantFrom('`', '``', '```', '````', '\n', 'a'), { maxLength: 20 }).map((p) => p.join('')));

/** Splits a block into its fence and lines, asserting the shape on the way. */
function parts(block: string, body: string): { fence: string; lines: string[] } {
  const m = /^(`+)post p1/.exec(block);
  assert.ok(m, 'the block must start with a fence and the post id');
  const fence = m[1];
  assert.ok(fence.length >= 3);
  const firstEnd = block.indexOf('\n');
  assert.ok(block.slice(0, firstEnd).endsWith(' UNTRUSTED-TEXT'));
  assert.ok(block.endsWith(`\n${fence}`));
  assert.equal(block.slice(firstEnd + 1, block.length - fence.length - 1), body);
  return { fence, lines: block.split('\n') };
}

test('property: the block is a fence, an info line, the body exactly, and the same fence', () => {
  check(bodies, (body) => { parts(postBlock(post(body)), body); });
});

test('property: no line inside the block is a run of backticks long enough to close the fence', () => {
  check(bodies, (body) => {
    const { fence, lines } = parts(postBlock(post(body)), body);
    for (const line of lines.slice(1, -1)) {
      assert.ok(!(/^`+$/.test(line) && line.length >= fence.length), `line ${JSON.stringify(line)} closes the fence`);
    }
  });
});

test('property: a body with no backticks is fenced with exactly three', () => {
  check(anyText().map((t) => t.replace(/`/g, '')), (body) => {
    assert.equal(parts(postBlock(post(body)), body).fence, '```');
  });
});
