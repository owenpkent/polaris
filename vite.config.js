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
  },
})
