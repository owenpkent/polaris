// `npm run test:ui`: build the dashboard, then run the Playwright projects, all under the
// machine-wide UI suite lock (e2e/suiteLock.js), so a build that replaces dist/ never runs under
// another suite that is serving it.
//
//   npm run test:ui                                 every project
//   npm run test:ui -- --shard=3/12                 what CI runs
//   npm run test:ui -- --grep "context menu"        arguments reach Playwright one for one
//
// Both CLIs are run through node with argument arrays and no shell, so a quoted value with spaces
// or a regex with | arrives as a single argument (the way scripts/shots.mjs runs them). The child
// gets the lock's token in CC_UI_SUITE_LOCK, so its Playwright run goes on under this lock
// instead of waiting for it.
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireSuiteLock, TOKEN_ENV } from '../e2e/suiteLock.js'

export const PROJECTS = ['desktop', 'phone', 'desktop-light', 'phone-light', 'desktop-hc', 'phone-landscape', 'phone-320']

/** The arguments after the Playwright CLI path: `test`, one --project per project, then the caller's arguments unchanged. */
export function playwrightArgs(extra = []) {
  return ['test', ...PROJECTS.flatMap((project) => ['--project', project]), ...extra]
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const PLAYWRIGHT = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js')

function run(script, args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit', env })
    child.on('error', () => done(1))
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))
  })
}

async function main() {
  const extra = process.argv.slice(2)
  const lock = await acquireSuiteLock({ command: `npm run test:ui${extra.length ? ` -- ${extra.join(' ')}` : ''}` })
  // Ctrl+C reaches the child too; this process waits for it to finish before letting the lock go.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {})
  const env = { ...process.env, [TOKEN_ENV]: lock.token }
  let code = await run(VITE, ['build'], env)
  if (code === 0) code = await run(PLAYWRIGHT, playwrightArgs(extra), env)
  lock.release()
  process.exit(code)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
