// The version this server runs, as `GET /api/health` reports it and `GET /api/update` compares
// against: the version in command-center/package.json, read once at start.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const VERSION = (JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
