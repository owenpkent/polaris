// Serves the built dashboard (repo-root dist/, from `npm run build`) as static files. This is a
// fall-through in server.ts, not a router route, since router.ts has no wildcard support.
//
// Trust model: the app shell is served here with no bearer token, because a browser navigation
// (typing the URL, opening a bookmark) cannot attach an Authorization header. That is safe only
// because every /api call the shell then makes still needs the api token, and because the server
// stays bound to 127.0.0.1 and is reached remotely through tailscale serve, never exposed
// directly.
import { createReadStream, promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { sendError } from './errors.ts';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
};

function contentTypeFor(file: string): string {
  const ext = extname(file).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Decoded path -> segments to join under root, or undefined if the request is not servable. */
function segmentsFor(decoded: string): string[] | undefined {
  if (decoded === '/') return ['index.html'];
  if (decoded.endsWith('/')) return undefined; // no directory index in subfolders, no listings
  const parts = decoded.split('/');
  parts.shift(); // drop the leading empty segment from the leading '/'
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..' || seg.startsWith('.')) return undefined;
  }
  return parts;
}

function resolveFile(root: string, pathname: string): string | undefined {
  if (pathname.includes('\\') || pathname.includes('%00')) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;

  const segments = segmentsFor(decoded);
  if (!segments) return undefined;
  const file = join(root, ...segments);
  return file.startsWith(root + sep) ? file : undefined;
}

export type StaticHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;

/** Returns true when it answered the response; false when the server should send its usual JSON 404. */
export function createStaticHandler(root: string): StaticHandler {
  const resolvedRoot = resolve(root);

  return async function serveStatic(req, res, pathname) {
    const file = resolveFile(resolvedRoot, pathname);
    if (!file) return false;

    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(res, 405, 'MethodNotAllowed', 'method not allowed');
      return true;
    }

    const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    const cacheControl = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.headers['if-none-match'] === etag) {
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', cacheControl);
      res.statusCode = 304;
      res.end();
      return true;
    }

    res.setHeader('Content-Type', contentTypeFor(file));
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('ETag', etag);
    res.setHeader('Content-Length', String(stat.size));

    if (method === 'HEAD') {
      res.end();
      return true;
    }

    const stream = createReadStream(file);
    stream.on('error', () => {
      stream.destroy();
      if (res.headersSent) { res.destroy(); return; }
      // The file went away between stat and open: drop the headers that described it.
      for (const h of ['Content-Length', 'ETag', 'Cache-Control']) res.removeHeader(h);
      sendError(res, 404, 'NotFound', 'not found');
    });
    stream.pipe(res);
    return true;
  };
}
