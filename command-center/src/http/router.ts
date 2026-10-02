// Minimal path router for node:http. The REST surface is small and fully enumerated in
// src/http/rest.ts, so ":param" segment matching is all that's needed -- no wildcards, no regex.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App } from '../app.ts';
import { ValidationError } from '../core/index.ts';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Parsed request URL (path + query string), resolved against a dummy http://localhost base. */
  url: URL;
  /** Parsed JSON body, or undefined for GET/DELETE and empty bodies. */
  body: unknown;
  app: App;
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export type FindResult =
  | { kind: 'match'; handler: RouteHandler; params: Record<string, string> }
  | { kind: 'method_not_allowed'; methods: string[] }
  | { kind: 'not_found' };

export interface Router {
  add(method: string, pattern: string, handler: RouteHandler): void;
  find(method: string, pathname: string): FindResult;
}

interface CompiledRoute {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function decodeParam(name: string, raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // decodeURIComponent throws URIError on a malformed escape such as %E0%A4%A. Without this the
    // request would surface as a 500 InternalError, blaming the server for the caller's URL.
    throw new ValidationError(`invalid ${name} in path: ${raw}`);
  }
}

export function createRouter(): Router {
  const routes: CompiledRoute[] = [];
  return {
    add(method, pattern, handler) {
      routes.push({ method: method.toUpperCase(), segments: splitPath(pattern), handler });
    },
    find(method, pathname) {
      const upperMethod = method.toUpperCase();
      const parts = splitPath(pathname);
      const methodsForPath = new Set<string>();
      for (const route of routes) {
        if (route.segments.length !== parts.length) continue;
        const params: Record<string, string> = {};
        let matched = true;
        for (let i = 0; i < parts.length; i++) {
          const seg = route.segments[i];
          if (seg.startsWith(':')) params[seg.slice(1)] = decodeParam(seg.slice(1), parts[i]);
          else if (seg !== parts[i]) { matched = false; break; }
        }
        if (!matched) continue;
        methodsForPath.add(route.method);
        if (route.method === upperMethod) return { kind: 'match', handler: route.handler, params };
      }
      if (methodsForPath.size > 0) return { kind: 'method_not_allowed', methods: [...methodsForPath] };
      return { kind: 'not_found' };
    },
  };
}
