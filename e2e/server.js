import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A throwaway Command Center server on a fresh scratch database, one per Playwright worker
// (e2e/fixtures.js). It holds the demo seed (command-center/src/dev/seed-demo.ts: 9 tasks, 4
// inbox items) plus the UI test fixtures (seed-ui-test.ts: two projects, a board, a disabled
// rule, two more inbox items), and with CC_UI_PERF=1 the 500 task perf project (seed-perf.ts).
// The real database is never opened, and stop() kills the server and deletes the folder.
//
// Every worker gets its own server because Playwright can only run tests in parallel when they
// share nothing: with one server per run the whole suite ran on one worker. The API token is
// fixed through CC_API_TOKEN so the tests connect with the same one-time URL handoff that
// scripts/mockup.mjs uses.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CC = join(ROOT, 'command-center')

// The first worker's port; worker n listens on BASE_PORT + n. CC_UI_PORT moves the whole block,
// so two clones can run at once on one machine.
export const BASE_PORT = Number(process.env.CC_UI_PORT) || 8791
export const TOKEN = 'ui-test-token'

async function waitForServer(url, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Command Center server did not answer at ${url}`)
}

// Resolves when nothing listens on 127.0.0.1:port, rejects when something does. Without this an
// orphaned server from an earlier run answers the readiness poll, the new process dies with
// EADDRINUSE unseen, and the worker silently runs on a database full of old tasks.
function assertPortFree(port) {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', (err) => {
      reject(
        new Error(
          `Port ${port} is already in use (${err.code || err.message}): a server from an earlier run is probably still running. ` +
            `Stop it with: pkill -f "serve --port ${port}"`,
        ),
      )
    })
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePort()))
  })
}

export async function startScratchServer(port) {
  await assertPortFree(port)
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-ui-test-'))
  // CC_SECRETS_DIR and CC_BACKUP_DIR keep the test server out of this machine's real secret store
  // and real backup folder: the settings test sets a backup passphrase.
  const env = {
    ...process.env,
    CC_DB: join(dataDir, 'constellation.db'),
    CC_API_TOKEN: TOKEN,
    CC_SECRETS_DIR: join(dataDir, 'secrets'),
    CC_BACKUP_DIR: join(dataDir, 'backups'),
    // The test server's GitHub is a fake (command-center/src/dev/githubFake.ts): a fixture
    // sign-in in the scratch secret store and three fixture repos, so github.spec.js can use the
    // GitHub view. Only `serve` reads this flag, and only this value; no request leaves the process.
    CC_GITHUB_FAKE: '1',
  }

  // The seed moment, which the clock fixture freezes every page to, so the relative dates the
  // seeds write ("due today") and what the dashboard shows agree on every run.
  const seededAt = new Date().toISOString()

  // seed-demo first, so its tasks stay without a project; then the Board and Rules fixtures.
  // seed-perf runs last, and only when CC_UI_PERF=1: it adds 500 open tasks (200 of them board
  // cards) for e2e/perf.spec.js, run on request with `CC_UI_PERF=1 npx playwright test --project
  // perf`, or weekly.
  const seeds = ['src/dev/seed-demo.ts', 'src/dev/seed-ui-test.ts']
  if (process.env.CC_UI_PERF === '1') seeds.push('src/dev/seed-perf.ts')
  for (const script of seeds) {
    const seeded = spawnSync(process.execPath, [script], { cwd: CC, env, encoding: 'utf8' })
    if (seeded.status !== 0) {
      rmSync(dataDir, { recursive: true, force: true })
      throw new Error(`Seeding the scratch database failed (${script}):\n${seeded.stderr}`)
    }
  }

  const server = spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(port)], {
    cwd: CC,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  // Keep the tail of stderr so a server that dies at start can say why.
  let stderrTail = ''
  server.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).split('\n').slice(-20).join('\n')
  })
  const died = new Promise((_, reject) => {
    server.once('exit', (code, signal) => {
      const lastLines = stderrTail.trim().split('\n').slice(-10).join('\n')
      reject(
        new Error(
          `Command Center server on port ${port} exited before it answered (${signal ? `signal ${signal}` : `code ${code}`})` +
            (lastLines ? `:\n${lastLines}` : ''),
        ),
      )
    })
  })
  died.catch(() => {}) // handled by the race below, or ignored once the server is up and stops later
  const url = `http://127.0.0.1:${port}`
  try {
    await Promise.race([waitForServer(`${url}/`), died])
  } catch (err) {
    server.kill()
    rmSync(dataDir, { recursive: true, force: true })
    throw err
  }

  return {
    url,
    port,
    seededAt,
    async stop() {
      // Wait for the server to be gone before removing its folder: on Windows a file the process
      // still holds (the database) makes the removal fail with EPERM, and that must not fail a
      // run whose tests all passed. A folder left in Temp is a nuisance, not a result.
      const exited = new Promise((r) => server.once('exit', r))
      server.kill()
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (err) {
        console.warn(`The scratch folder ${dataDir} could not be removed: ${err.message}`)
      }
    },
  }
}
