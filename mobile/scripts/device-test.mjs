// What the scripts that run against an emulator share, used by test.mjs and offline-check.mjs:
// finding adb, picking the device, a free port, the scratch daemon and the wait for it, and `run`.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { win } from './android-env.mjs'

/** The path to adb inside the SDK, or an exit with the message that says what is missing. */
export function requireAdb(sdk) {
  const adb = join(sdk, 'platform-tools', win ? 'adb.exe' : 'adb')
  if (!existsSync(adb)) {
    console.error(`adb not found at ${adb}. Install the SDK's platform-tools.`)
    process.exit(1)
  }
  return adb
}

/** Runs a command with its output shown, and exits with its code when it fails. */
export function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: win && command === 'npm', ...options })
  if (result.status !== 0) {
    console.error(`${command} ${commandArgs.join(' ')} failed (${result.status ?? result.signal}).`)
    process.exit(result.status || 1)
  }
}

function adbOutput(adb, adbArgs) {
  return spawnSync(adb, adbArgs, { encoding: 'utf8' }).stdout || ''
}

/** The serial to use: ANDROID_SERIAL, else the one running emulator. Never a physical phone by default. */
export function pickDevice(adb) {
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL
  const ready = adbOutput(adb, ['devices'])
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

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

/**
 * Starts the scratch daemon (`npm run cc -- serve` without npm) on the port, with its own database,
 * secret store, and backup folder inside the scratch folder, and CC_CORS_ORIGINS=https://localhost.
 * It is not waited for: use waitForServer.
 */
export function startScratchServer({ cc, port, scratch, token }) {
  return spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(port)], {
    cwd: cc,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      CC_DB: join(scratch, 'polaris.db'),
      CC_API_TOKEN: token,
      CC_SECRETS_DIR: join(scratch, 'secrets'),
      CC_BACKUP_DIR: join(scratch, 'backups'),
      CC_CORS_ORIGINS: 'https://localhost',
    },
  })
}

export async function waitForServer(url, token, server) {
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
