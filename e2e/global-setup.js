import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export { TOKEN } from './server.js'

// The servers themselves start per worker in e2e/fixtures.js (see e2e/server.js). This only
// checks that there is a dashboard to serve.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export default async function globalSetup() {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/ is missing. Run "npm run test:ui", which builds the dashboard first.')
  }
}
