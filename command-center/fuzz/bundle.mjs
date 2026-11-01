// Shared esbuild step for the Jazzer.js harness: each entry point becomes one CommonJS bundle of
// our own code. Packages stay external, so Jazzer.js instruments only src/ and fuzz/ (the
// --includes filter in run.mjs matches the bundle path) and leaves dependencies alone. A bundle
// rather than a per-file transpile because src/ imports with explicit .ts extensions, which a
// CommonJS require could not resolve. The package is "type": "module", so the output is .cjs.
//
// esbuild is the root package's (the dashboard build's), resolved up the tree from here: it is
// not a dependency of command-center, whose lockfile has no install scripts because `cc update`
// installs it with --ignore-scripts (src/update/installScripts.test.ts). Run `npm ci` at the repo
// root before fuzzing.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));

export function bundle(entryPoints, outdir) {
  return build({
    absWorkingDir: root,
    entryPoints,
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    packages: 'external',
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    sourcemap: 'linked',
    sourcesContent: false,
    logLevel: 'warning',
  });
}
