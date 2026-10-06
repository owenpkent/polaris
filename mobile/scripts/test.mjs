// Runs the Android app's instrumented tests on an emulator that is already running.
//
//   npm --prefix mobile run test:device [-- <gradle arguments>]     (or `npm run test:android` at the root)
//
// What it does, in order: builds the dashboard (dist/), copies it into the Android project
// (cap sync), starts a scratch daemon on the host, forwards the daemon's port to the emulator with
// `adb reverse`, and runs `connectedDebugAndroidTest`. The daemon, the port forward, and the
// scratch folder are removed afterwards, whether the tests passed or not.
//
// The scratch daemon is `npm run cc -- serve` on a free port with its own database, secret store,
// and backup folder in a temp directory, and CC_CORS_ORIGINS=https://localhost (the origin the
// dashboard has inside the app). It never touches command-center/data or a daemon already running
// on the default port.
//
// Options: --skip-build reuses dist/ from the last `npm run build`. Anything else goes to Gradle,
// for example `-Pandroid.testInstrumentationRunnerArguments.class=com.okstudio.polaris.ShareRewriteTest`.
// ANDROID_SERIAL picks the device; without it the one running emulator is used. A physical phone
// is never picked automatically.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidDir, gradlew, requireToolchain, win } from './android-env.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOBILE = join(ROOT, 'mobile')
const CC = join(ROOT, 'command-center')

const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')
const gradleArgs = args.filter((arg) => arg !== '--skip-build')

const { jdk, sdk } = requireToolchain()
const adb = join(sdk, 'platform-tools', win ? 'adb.exe' : 'adb')
if (!existsSync(adb)) {
  console.error(`adb not found at ${adb}. Install the SDK's platform-tools.`)
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: win && command === 'npm', ...options })
  if (result.status !== 0) {
    console.error(`${command} ${commandArgs.join(' ')} failed (${result.status ?? result.signal}).`)
    process.exit(result.status || 1)
  }
}

function adbOutput(adbArgs) {
  return spawnSync(adb, adbArgs, { encoding: 'utf8' }).stdout || ''
}

function pickDevice() {
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL
  const ready = adbOutput(['devices'])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial)
  const emulators = ready.filter((serial) => serial.startsWith('emulator-'))
  if (emulators.length === 1) return emulators[0]
  if (emulators.length > 1) {
    console.error(`More than one emulator is running (${emulators.join(', ')}). Set ANDROID_SERIAL to pick one.`)
  } else if (ready.length) {
    console.error(`Only a physical device is attached (${ready.join(', ')}). Start an emulator, or set ANDROID_SERIAL to use it on purpose.`)
  } else {
    console.error('No emulator is running. Start one (emulator -avd <name>) and wait for it to boot.')
  }
  process.exit(1)
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

async function waitForServer(url, token, server) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`The scratch server exited early (code ${server.exitCode}).`)
    try {
      const res = await fetch(`${url}/api/health`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`The scratch server did not answer at ${url} within 30 seconds.`)
}

const serial = pickDevice()
process.env.ANDROID_SERIAL = serial
console.log(`Device: ${serial}`)

if (!skipBuild) run('npm', ['run', 'build'], { cwd: ROOT })
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing: run `npm run build` at the repo root, or drop --skip-build.')
  process.exit(1)
}
run('npm', ['run', 'sync'], { cwd: MOBILE })

const scratch = mkdtempSync(join(tmpdir(), 'cc-android-test-'))
const token = randomBytes(24).toString('hex')
const port = await freePort()
const serverUrl = `http://127.0.0.1:${port}`
let server
let forwarded = false

function cleanup() {
  if (forwarded) {
    spawnSync(adb, ['-s', serial, 'reverse', '--remove', `tcp:${port}`], { stdio: 'ignore' })
    forwarded = false
  }
  if (server && server.exitCode === null) server.kill()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup()
    process.exit(130)
  })
}

let status = 1
try {
  server = spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(port)], {
    cwd: CC,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      CC_DB: join(scratch, 'constellation.db'),
      CC_API_TOKEN: token,
      CC_SECRETS_DIR: join(scratch, 'secrets'),
      CC_BACKUP_DIR: join(scratch, 'backups'),
      CC_CORS_ORIGINS: 'https://localhost',
    },
  })
  await waitForServer(serverUrl, token, server)
  console.log(`Scratch server: ${serverUrl} (database in ${scratch})`)

  run(adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`])
  forwarded = true

  const result = spawnSync(
    gradlew,
    [
      'connectedDebugAndroidTest',
      `-Pandroid.testInstrumentationRunnerArguments.serverUrl=${serverUrl}`,
      `-Pandroid.testInstrumentationRunnerArguments.apiToken=${token}`,
      ...gradleArgs,
    ],
    { cwd: androidDir, stdio: 'inherit', shell: win, env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk } },
  )
  status = result.status ?? 1
} catch (err) {
  console.error(err.message)
} finally {
  cleanup()
}
if (status === 0) console.log(`Reports: ${join(androidDir, 'app', 'build', 'reports', 'androidTests', 'connected')}`)
process.exit(status)
