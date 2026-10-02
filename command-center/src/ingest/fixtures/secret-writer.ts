// A separate process for secrets.test.ts: waits for the start file, then writes `count` keys of
// its own into the shared secret file and reports how each write went.
import { existsSync } from 'node:fs';
import { fileSecretStore } from '../secrets.ts';

const [file, prefix, count, startFile] = process.argv.slice(2);
const store = fileSecretStore(file);
while (!existsSync(startFile)) await new Promise((r) => setTimeout(r, 2));

const failed: string[] = [];
for (let i = 0; i < Number(count); i++) {
  try { await store.set(`${prefix}-${i}`, `value-${prefix}-${i}`); } catch (e) { failed.push(`${prefix}-${i}: ${e instanceof Error ? e.message : String(e)}`); }
}
process.stdout.write(JSON.stringify({ failed }));
