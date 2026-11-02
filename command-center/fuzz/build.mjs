// Bundles fuzz/targets/*.fuzz.ts to fuzz/.out/<target>.fuzz.cjs (untracked).
import { globSync } from 'node:fs';

import { bundle } from './bundle.mjs';

bundle(globSync('fuzz/targets/*.fuzz.ts'), 'fuzz/.out').catch(() => process.exit(1));
