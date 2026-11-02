import type { Post } from '../../src/core/index.ts';
import { postBlock } from '../../src/mcp/format.ts';

// A thread post is rendered for an assistant inside a backtick fence that nothing in the body can
// close, so a third party's text cannot step out of the data block and read as the tool's own
// prose. The input is the body. The block must be the fence and info line, the body exactly, and
// the fence again, with no line in between that could close it.
export function fuzz(data: Buffer): void {
  const body = data.toString('utf8');
  const post: Post = {
    id: 'p1', threadId: 't1', parentPostId: null, author: 'agent', authorName: null, type: 'claim', body,
    confidence: null, status: null, refs: [], untrustedText: true, judgedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
  };
  const block = postBlock(post);
  const m = /^(`+)post p1 /.exec(block);
  if (!m) throw new Error(`block does not start with a fence: ${JSON.stringify(block.slice(0, 40))}`);
  const fence = m[1];
  const firstEnd = block.indexOf('\n');
  if (!block.slice(0, firstEnd).endsWith(' UNTRUSTED-TEXT')) throw new Error('info line lost the marker');
  if (!block.endsWith(`\n${fence}`)) throw new Error('block does not end with the fence');
  if (block.slice(firstEnd + 1, block.length - fence.length - 1) !== body) throw new Error('body was changed inside the block');
  const lines = block.split('\n');
  for (const line of lines.slice(1, -1)) {
    if (/^`+$/.test(line) && line.length >= fence.length) throw new Error(`a body line closes the fence: ${JSON.stringify(line)}`);
  }
}
