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

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidDir, gradlew, requireToolchain, win } from './android-env.mjs'
import { freePort, pickDevice, requireAdb, run, startScratchServer, waitForServer } from './device-test.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOBILE = join(ROOT, 'mobile')
const CC = join(ROOT, 'command-center')

const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')
const gradleArgs = args.filter((arg) => arg !== '--skip-build')

const { jdk, sdk } = requireToolchain()
const adb = requireAdb(sdk)

const serial = pickDevice(adb)
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
  server = startScratchServer({ cc: CC, port, scratch, token })
  await waitForServer(serverUrl, token, server)
  console.log(`Scratch server: ${serverUrl} (database in ${scratch})`)

  run(adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`])
  forwarded = true

  // On POSIX go through sh, so a checkout that lost the wrapper's executable bit still works.
  const gradleArguments = [
    'connectedDebugAndroidTest',
    `-Pandroid.testInstrumentationRunnerArguments.serverUrl=${serverUrl}`,
    `-Pandroid.testInstrumentationRunnerArguments.apiToken=${token}`,
    ...gradleArgs,
  ]
  const result = spawnSync(win ? gradlew : 'sh', win ? gradleArguments : [gradlew, ...gradleArguments], {
    cwd: androidDir,
    stdio: 'inherit',
    shell: win,
    env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk },
  })
  if (result.error) {
    console.error(`Could not start Gradle (${gradlew}): ${result.error.message}`)
    status = 127
  } else if (result.status === null) {
    console.error(`Gradle was stopped by signal ${result.signal}.`)
    status = 1
  } else {
    status = result.status
    if (status !== 0) console.error(`Gradle ran and the Android tests failed (exit code ${status}).`)
  }
} catch (err) {
  console.error(err.message)
} finally {
  cleanup()
}
if (status === 0) console.log(`Reports: ${join(androidDir, 'app', 'build', 'reports', 'androidTests', 'connected')}`)
process.exit(status)
