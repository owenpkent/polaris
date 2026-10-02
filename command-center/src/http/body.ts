// Request body reading: capped at 1 MB, JSON only. Stops accumulating chunks the moment the cap
// is crossed (never buffers an oversized body into memory just to reject it).
import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.ts';

export interface ReadBodyOptions {
  /** Resolve to undefined for a zero-length body instead of throwing 400. Default true. */
  allowEmpty?: boolean;
}

export function readJsonBody(req: IncomingMessage, maxBytes: number, opts: ReadBodyOptions = {}): Promise<unknown> {
  const allowEmpty = opts.allowEmpty ?? true;
  return new Promise((resolve, reject) => {
    let total = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        reject(new HttpError(413, 'PayloadTooLarge', `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (total === 0) {
        if (allowEmpty) { resolve(undefined); return; }
        reject(new HttpError(400, 'BadRequest', 'request body is required'));
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '');
      if (!contentType.toLowerCase().includes('application/json')) {
        reject(new HttpError(400, 'BadRequest', 'Content-Type must be application/json'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks, total).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'BadRequest', 'invalid JSON body'));
      }
    });
    req.on('error', (e) => { if (!tooLarge) reject(e); });
  });
}
