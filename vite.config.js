import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// The build the dashboard shows on Settings, About: the package version, the commit it was built
// from, and when. Read once when Vite starts; a build outside a git checkout has no commit.
function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const buildInfo = { version, commit: gitCommit(), builtAt: new Date().toISOString() }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __BUILD_INFO__: JSON.stringify(buildInfo) },
  publicDir: 'public',
  build: {
    outDir: 'dist',
  },
  // Dashboard unit tests (npm test). Command Center has its own node:test suite.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}', 'e2e/**/*.test.js', 'mobile/scripts/**/*.test.js'],
    restoreMocks: true,
    setupFiles: ['src/setupTests.js'],
    // `cc update` runs this suite on the install's own machine, which may be busy (an editor, an
    // agent, a build) when the daily update lands. The defaults (5s a test, 1s for Testing
    // Library's findBy and waitFor) made a 16-core box at load 12 roll an update back on seven
    // timeouts with nothing wrong. A passing test is as fast as before; only a slow one waits longer.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
