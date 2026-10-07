import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// Helpers for driving the real desktop app. Read desktop/e2e/playwright.config.js first.
//
// SAFETY. The owner's own Constellation, with their real database, may be running on port 8788.
// Everything here is built so that cannot be touched:
//   - The app is started with CC_DB, CC_SECRETS_DIR, CC_BACKUP_DIR, APPDATA, and LOCALAPPDATA
//     all inside a fresh temp folder, and with CC_PORT set to a free port that is never the
//     daemon's default. WebView2 does not follow APPDATA or LOCALAPPDATA (Tauri finds its profile
//     through the known-folder API), so launchApp also sets WEBVIEW2_USER_DATA_FOLDER, and checks
//     that the profile really appeared under the temp folder. main.rs reads the port and the database
//     from exactly these variables, so no code in the shell had to change.
//   - Every inherited CC_* variable is dropped first, so none of the owner's settings leak in.
//   - A process is killed only if this run started it (the app, which takes the daemon it
//     started with it, and the servers made here). Nothing is ever found by name and stopped.
//   - The app is single-instance per user session, so a copy of Constellation the owner has open
//     would swallow the launch. launchApp refuses to start while one is running.
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const CC = join(ROOT, 'command-center')
export const APP_EXE = join(ROOT, 'desktop', 'src-tauri', 'target', 'debug', 'constellation-desktop.exe')
// The port the daemon uses when nothing says otherwise (desktop/src-tauri/src/daemon.rs).
const OWNERS_PORT = 8788

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function until(what, check, { timeout = 30000, every = 200 } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try {
      const value = await check()
      if (value) return value
    } catch (err) {
      last = err
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
    await sleep(every)
  }
}

/** A port nothing listens on now, never the owner's. */
export function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => (port === OWNERS_PORT ? freePort().then(resolvePort, reject) : resolvePort(port)))
    })
  })
}

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${script}; exit 0`], { encoding: 'utf8', windowsHide: true })
}

/** Direct children of a process as { pid, name, commandLine }. */
export function childrenOf(pid) {
  const out = powershell(
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
  ).trim()
  if (!out) return []
  return [].concat(JSON.parse(out)).map((r) => ({ pid: r.ProcessId, name: r.Name, commandLine: r.CommandLine || '' }))
}

/** node.exe daemons that carry this port on their command line, whoever started them. */
export function daemonsOnPort(port) {
  const out = powershell(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'daemon --port ${Number(port)}( |$)' } | Select-Object ProcessId | ConvertTo-Json -Compress`,
  ).trim()
  return out ? [].concat(JSON.parse(out)).map((r) => r.ProcessId) : []
}

export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** Stops a process tree this run started. The one place a process is ever killed. */
function killTree(pid) {
  if (!pid || !alive(pid)) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    // already gone
  }
}

// Asks the app's window to close, as the X button does (WM_CLOSE). The windows are found by the
// owning process id, never by title or name.
const CLOSE_WINDOWS = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int Close(uint target) {
    int n = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target || !IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (cls.ToString() == "ConsoleWindowClass") return true;
      PostMessage(h, 0x10, IntPtr.Zero, IntPtr.Zero); n++; return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
[W]::Close(__PID__)
`

/** Posts WM_CLOSE to the app's windows. Returns how many it asked. */
export function closeWindowOf(pid) {
  return Number(powershell(CLOSE_WINDOWS.replace('__PID__', String(Number(pid)))).trim().split(/\s+/).pop())
}

/** A running copy of the owner's app, or of this debug build, would take over the launch. */
function assertNoOtherApp() {
  const out = powershell(
    `Get-Process -Name Constellation,constellation-desktop -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress`,
  ).trim()
  if (!out) return
  const found = [].concat(JSON.parse(out)).map((p) => `${p.Id} ${p.Path}`)
  throw new Error(
    `Constellation is already running (${found.join('; ')}). The app allows one copy per user, so a test launch would ` +
      'only focus it. Close it and run again. The tests never stop a process they did not start.',
  )
}

/** A fresh folder for one test: a database, secrets, backups, and the app's own profile folders. */
export function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-desktop-ui-'))
  const scratch = {
    dir,
    db: join(dir, 'data', 'constellation.db'),
    secrets: join(dir, 'secrets'),
    backups: join(dir, 'backups'),
    appData: join(dir, 'appdata'),
    localAppData: join(dir, 'localappdata'),
    // Made by WebView2 itself, not here, so its appearance proves the override was honoured.
    webview2: join(dir, 'webview2-profile'),
    remove() {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (err) {
        console.warn(`The scratch folder ${dir} could not be removed: ${err.message}`)
      }
    },
  }
  for (const d of [dirname(scratch.db), scratch.secrets, scratch.backups, scratch.appData, scratch.localAppData]) mkdirSync(d, { recursive: true })
  return scratch
}

/** The environment for anything started here: the scratch locations, and none of the owner's CC_* settings. */
export function scratchEnv(scratch, { port, token }) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CC_|WEBVIEW2_|HTTPS?_PROXY$|NO_PROXY$)/i.test(key)) env[key] = value
  }
  return {
    ...env,
    CC_DB: scratch.db,
    CC_PORT: String(port),
    CC_API_TOKEN: token,
    CC_SECRETS_DIR: scratch.secrets,
    CC_BACKUP_DIR: scratch.backups,
    APPDATA: scratch.appData,
    LOCALAPPDATA: scratch.localAppData,
  }
}

/** A Command Center started here with `serve`, standing in for a daemon that is already running. */
export async function startServer(scratch, { port, token }) {
  const child = spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(port)], {
    cwd: CC,
    env: scratchEnv(scratch, { port, token }),
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr = (stderr + c).slice(-2000)))
  await until(`the server on ${port}`, async () => {
    if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}: ${stderr}`)
    return (await fetch(`http://127.0.0.1:${port}/api/identity?challenge=${'0'.repeat(32)}`)).ok
  })
  return { pid: child.pid, port, token, kill: () => killTree(child.pid) }
}

/** A plain HTTP server on the port that answers every request as told, and records what it was asked. */
export async function startImpostor(port, respond) {
  const requests = []
  const server = createHttpServer((req, res) => {
    requests.push({ url: req.url, headers: { ...req.headers } })
    const { status, body } = respond(req)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body)
  })
  await new Promise((r, j) => server.once('error', j).listen(port, '127.0.0.1', r))
  return { requests, stop: () => new Promise((r) => server.close(r)) }
}

/**
 * Starts the debug app against the scratch locations and attaches to its WebView2 over CDP.
 * `cleanup` stops only what this call started.
 */
export async function launchApp(scratch, { port, token }) {
  if (!existsSync(APP_EXE)) throw new Error(`The debug app is not built: ${APP_EXE}. Run npm run test:desktop:ui, which builds it.`)
  if (port === OWNERS_PORT) throw new Error('refusing to run the app on the default port')
  assertNoOtherApp()
  const cdpPort = await freePort()
  const env = {
    ...scratchEnv(scratch, { port, token }),
    // After scratchEnv, which strips inherited WEBVIEW2_* variables. Replaces the user-data folder.
    WEBVIEW2_USER_DATA_FOLDER: scratch.webview2,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    // The updater's check on GitHub, a few seconds after start, goes nowhere. Loopback is exempt,
    // because the shell's own probe of the daemon must not go through it.
    HTTPS_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
  }
  const child = spawn(APP_EXE, [], { cwd: scratch.dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (c) => (output = (output + c).slice(-4000)))
  const dataDir = dirname(scratch.db)
  const app = {
    pid: child.pid,
    port,
    token,
    scratch,
    cdpPort,
    output: () => output,
    exited: () => child.exitCode !== null,
    /** The shell's own log (desktop.log): what it found, what it started, and why it could not. */
    appLog: () => readText(join(dataDir, 'desktop.log')),
    daemonLog: () => readText(join(dataDir, 'daemon.log')),
    /** node.exe children of the app: the daemon, when the app started one. */
    daemonChildren: () => childrenOf(child.pid).filter((c) => /^node\.exe$/i.test(c.name)),
    close: () => closeWindowOf(child.pid),
    cleanup: async () => {
      try {
        await app.browser?.close()
      } catch {
        // the app may be gone already
      }
      killTree(child.pid)
    },
  }
  try {
    try {
      await until('the app to open its debugging port', async () => {
        if (child.exitCode !== null) {
          throw new Error(`the app exited with ${child.exitCode} before it was ready. If Constellation is already open, close it.`)
        }
        return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok
      }, { timeout: 60000 })
    } catch (err) {
      // The fixture attaches the logs of an app that launched. One that did not is only ever
      // seen here, so everything there is to read goes into the error itself.
      throw new Error(`${err.message}\n\n${launchDiagnostics(child, scratch, output)}`)
    }
    // Verified, not assumed: a profile anywhere else would be the owner's real one.
    if (!existsSync(scratch.webview2)) {
      throw new Error(`WebView2 did not create its profile under ${scratch.webview2}, so it may be using the owner's real profile.`)
    }
    app.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
    app.context = app.browser.contexts()[0]
    await app.context.tracing.start({ screenshots: true, snapshots: true })
    app.page = await until('the app window', () => app.context.pages()[0], { timeout: 30000 })
  } catch (err) {
    await app.cleanup()
    throw err
  }
  return app
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** The installed WebView2 runtime (the Evergreen runtime or a per-user install), as the registry lists it. */
export function webView2Runtime() {
  const client = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  const keys = [
    `HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${client}`,
    `HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${client}`,
    `HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\${client}`,
  ]
  try {
    const out = powershell(
      `foreach ($k in '${keys.join("','")}') { $v = (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue).pv; if ($v) { "$v at $k"; break } }`,
    ).trim()
    return out || 'none found in the registry'
  } catch (err) {
    return `unknown (${err.message})`
  }
}

/** Everything there is to read about an app that did not open its debugging port. */
function launchDiagnostics(child, scratch, output) {
  const dataDir = dirname(scratch.db)
  const children = (() => {
    try {
      return childrenOf(child.pid).map((c) => `${c.name} (${c.pid})`)
    } catch (err) {
      return [`unknown: ${err.message}`]
    }
  })()
  return [
    `app pid ${child.pid}, exit code ${child.exitCode === null ? 'none (still running)' : child.exitCode}`,
    `children of the app: ${children.length ? children.join(', ') : 'none'}`,
    `WebView2 profile under scratch: ${existsSync(scratch.webview2) ? 'yes' : 'no'}`,
    `WebView2 runtime: ${webView2Runtime()}`,
    `desktop.log:\n${readText(join(dataDir, 'desktop.log')) || '(empty)'}`,
    `daemon.log:\n${readText(join(dataDir, 'daemon.log')).slice(-3000) || '(none)'}`,
    `app output:\n${output || '(none)'}`,
  ].join('\n')
}
