// Checks the offline queue inside the real Android app, on an emulator that is already running.
//
//   npm --prefix mobile run test:offline [-- --skip-build] [-- --shots <folder>]     (or `npm run test:android:offline` at the root)
//
// What it does, in order: stops unless the emulator allows root, builds the dashboard (dist/), copies
// it into the Android project (cap sync), builds the debug APK, starts a scratch daemon on the host
// (the same one test.mjs starts), forwards its port to the emulator with `adb reverse`, installs the
// APK, clears the app's data, launches it, and drives the app's own WebView with Playwright's Android
// support. It connects through the form, then checks, on the device:
//   - the queue keeps two offline edits in the order they were made when the device clock is set
//     back ten minutes between them, and a device editing its own field records no conflict;
//   - an offline edit made later by a device that is ten minutes behind wins over an earlier live
//     edit from another client, and the loser is kept in the task's history as task.sync_conflict;
//   - the About card's Device clock row says "10 minutes behind the server's clock", with its notice.
// One PASS or FAIL line is printed per check, then a total. The exit code is 0 only if every check
// passed.
//
// What it changes on the device, and puts back whatever happened (also on Ctrl+C): the clock, which is
// set ten minutes back for a moment and then to this machine's time, and the automatic time setting
// (`settings get global auto_time` is read first and the value it had is restored). The app's data is
// cleared and the debug APK is installed over any copy there. It needs `adb root`, so it only runs
// on an emulator image that allows root (a Google APIs image, not a Google Play one), and it refuses
// any device that is not an emulator. Nothing here is part of CI.
//
// To take the app offline it stops the scratch daemon, removes the port forward, and starts the daemon
// again: removing the forward alone leaves the WebView's open connections working.
//
// Options: --skip-build reuses dist/ from the last `npm run build`. --shots <folder> writes a
// screenshot of the About card there; without it no screenshot is written. ANDROID_SERIAL picks the
// device; without it the one running emulator is used.
//
// Playwright is not a dependency of mobile/. It comes from the repository root's node_modules, so
// run `npm install` at the root first.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidDir, requireToolchain } from './android-env.mjs'
import { recoveryCommands } from './clockRecovery.mjs'
import { freePort, pickDevice, requireAdb, run, startScratchServer, waitForServer } from './device-test.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOBILE = join(ROOT, 'mobile')
const CC = join(ROOT, 'command-center')
const PKG = 'com.okstudio.polaris'
const APK = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const SKEW_SECONDS = -600

const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')
const shotsAt = args.indexOf('--shots')
const shotsDir = shotsAt >= 0 ? args[shotsAt + 1] : undefined
const unknown = args.filter((arg, i) => arg !== '--skip-build' && arg !== '--shots' && !(shotsAt >= 0 && i === shotsAt + 1))
if (unknown.length || (shotsAt >= 0 && !shotsDir)) {
  console.error('Usage: offline-check.mjs [--skip-build] [--shots <folder>]')
  process.exit(1)
}

const { sdk } = requireToolchain()
const adbPath = requireAdb(sdk)

const serial = pickDevice(adbPath)
process.env.ANDROID_SERIAL = serial
console.log(`Device: ${serial}`)
// This script sets the clock and needs root, so a physical phone is refused even when ANDROID_SERIAL names it.
if (!serial.startsWith('emulator-')) {
  console.error(`${serial} is not an emulator. This check changes the device clock, so it only runs on an emulator.`)
  process.exit(1)
}

// Playwright attaches to every device adb lists, so no phone may be attached at all, not only
// unused, and in whatever state adb shows it (ready, unauthorized, offline).
const phones = (spawnSync(adbPath, ['devices'], { encoding: 'utf8' }).stdout || '')
  .split('\n')
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter(([name, state]) => name && state && !name.startsWith('emulator-'))
  .map(([name]) => name)
if (phones.length) {
  console.error(`A physical device is attached to adb (${phones.join(', ')}). Unplug it, or disconnect it from adb, and run again.`)
  process.exit(1)
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function adb(...adbArgs) {
  const result = spawnSync(adbPath, ['-s', serial, ...adbArgs], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`adb ${adbArgs.join(' ')}: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

// Needs a root adbd: a Google APIs emulator image has one, a Google Play image does not.
const noRootMessage = 'adb cannot run as root on this device. Use an emulator on a Google APIs image, not a Google Play one.'
const rooting = spawnSync(adbPath, ['-s', serial, 'root'], { encoding: 'utf8', timeout: 30000 })
if (/cannot run as root/.test(`${rooting.stdout}${rooting.stderr}`)) {
  console.error(noRootMessage)
  process.exit(1)
}
if (spawnSync(adbPath, ['-s', serial, 'wait-for-device'], { timeout: 30000 }).status !== 0) {
  console.error(`${serial} did not come back within 30 seconds of adb root.`)
  process.exit(1)
}
let uid = ''
for (const end = Date.now() + 30000; uid !== '0' && Date.now() < end; ) {
  uid = (spawnSync(adbPath, ['-s', serial, 'shell', 'id', '-u'], { encoding: 'utf8', timeout: 10000 }).stdout || '').trim()
  if (uid !== '0') await sleep(1000)
}
if (uid !== '0') {
  console.error(noRootMessage)
  process.exit(1)
}

// Playwright comes from the repository root, which has it for the UI tests; mobile/ does not depend on it.
let android
try {
  android = createRequire(join(ROOT, 'package.json'))('playwright')._android
} catch {
  console.error('Playwright was not found. Run `npm install` at the repository root.')
  process.exit(1)
}

if (!skipBuild) run('npm', ['run', 'build'], { cwd: ROOT })
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing: run `npm run build` at the repo root, or drop --skip-build.')
  process.exit(1)
}
run('npm', ['run', 'sync'], { cwd: MOBILE })
run(process.execPath, [join(MOBILE, 'scripts', 'apk.mjs')], { cwd: MOBILE })
if (!existsSync(APK)) {
  console.error(`The debug APK is missing at ${APK}.`)
  process.exit(1)
}
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const scratch = mkdtempSync(join(tmpdir(), 'cc-android-offline-'))
const token = randomBytes(24).toString('hex')
const port = await freePort()
const base = `http://127.0.0.1:${port}`
let server
let forwarded = false
let device
let autoTimeBefore
let autoTimeTouched = false
let clockTouched = false

// What could not be put back. A problem found here fails the run.
const restoreProblems = new Set()
let recoveryShown = false

// Puts back what the run changed. It is entirely synchronous (spawnSync, rmSync, kill), because it
// runs from signal and exit handlers that cannot wait, and it is safe to call again: each step is
// skipped once it has worked.
function cleanup() {
  if (clockTouched) {
    try {
      adb('shell', 'date', `@${Math.floor(Date.now() / 1000)}`)
      clockTouched = false
      restoreProblems.delete('clock')
    } catch (err) {
      restoreProblems.add('clock')
      console.error(`Could not set the device clock back to this machine's time: ${err.message}`)
    }
  }
  if (autoTimeTouched) {
    try {
      if (autoTimeBefore === 'null' || autoTimeBefore === '') adb('shell', 'settings', 'delete', 'global', 'auto_time')
      else adb('shell', 'settings', 'put', 'global', 'auto_time', autoTimeBefore)
      autoTimeTouched = false
      restoreProblems.delete('auto_time')
    } catch (err) {
      restoreProblems.add('auto_time')
      console.error(`Could not restore the automatic time setting (it was ${autoTimeBefore}): ${err.message}`)
    }
  }
  if (restoreProblems.size && !recoveryShown) {
    recoveryShown = true
    const commands = recoveryCommands({
      serial,
      problems: restoreProblems,
      autoTimeBefore,
      nowSeconds: Math.floor(Date.now() / 1000),
    })
    console.error(`Put the emulator back by hand:\n${commands.map((c) => `  ${c}`).join('\n')}`)
  }
  if (forwarded) {
    spawnSync(adbPath, ['-s', serial, 'reverse', '--remove', `tcp:${port}`], { stdio: 'ignore' })
    forwarded = false
  }
  if (server && server.exitCode === null) server.kill()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup()
    process.exit(signal === 'SIGHUP' ? 129 : 130)
  })
}
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    console.error(`${event}: ${err?.stack || err}`)
    cleanup()
    process.exit(1)
  })
}
// The backstop for any other way out. A failed restore still makes the exit code non-zero.
process.on('exit', () => {
  cleanup()
  if (restoreProblems.size) process.exitCode = 1
})

// The scratch daemon logs every request it answers between these lines, so each one is printed as
// it happens and all of them again at the end, where they can be read together.
const results = []
const lines = []
function note(name, ok, detail) {
  results.push(ok)
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  console.log(lines.at(-1))
}

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// Polls check() until it returns { done: true }, or the time runs out; returns the last answer.
async function until(what, check, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    last = await check().catch((err) => ({ error: String(err) }))
    if (last && last.done) return last
    await sleep(1000)
  }
  return { ...last, done: false, timedOut: what }
}

async function startServer() {
  server = startScratchServer({ cc: CC, port, scratch, token })
  await waitForServer(base, token, server)
}
async function stopServer() {
  if (server.exitCode !== null) return
  const gone = new Promise((resolveExit) => server.once('exit', resolveExit))
  server.kill()
  await gone
}
function online() {
  adb('reverse', `tcp:${port}`, `tcp:${port}`)
  forwarded = true
}
// The server is stopped (which closes the WebView's open connections), the forward is removed, and
// the server is started again: this machine can still reach it, the device cannot.
async function offline() {
  await stopServer()
  try {
    adb('reverse', '--remove', `tcp:${port}`)
  } catch {
    // Not forwarded.
  }
  forwarded = false
  await startServer()
}

let status = 1
try {
  autoTimeBefore = adb('shell', 'settings', 'get', 'global', 'auto_time')
  autoTimeTouched = true
  adb('shell', 'settings', 'put', 'global', 'auto_time', '0')

  await startServer()
  console.log(`Scratch server: ${base} (database in ${scratch})`)

  online()
  adb('install', '-r', APK)
  adb('shell', 'pm', 'clear', PKG)
  adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1')

  const today = new Date()
  const dueAt = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const orderTask = (await api('POST', '/api/tasks', { title: 'Clock order check', dueAt })).task
  const timeTask = (await api('POST', '/api/tasks', { title: 'Clock time check', dueAt })).task

  // Only the WebView's own debugging socket is used, so Playwright's driver app is not installed.
  // No phone is attached (checked above); the one this run chose is taken from the list.
  let page
  try {
    device = (await android.devices({ omitDriverInstall: true })).find((d) => d.serial() === serial)
    if (!device) throw new Error(`Playwright did not list the device ${serial}.`)
    const webview = await device.webView({ pkg: PKG }, { timeout: 60000 })
    page = await webview.page()
  } catch (err) {
    throw new Error(`Could not attach to the app's WebView: ${err.message}\nThe installed app must be the debug build this script just installed (a release build is not debuggable). If it is, Playwright may need its driver app after all: remove omitDriverInstall in offline-check.mjs.`)
  }
  page.setDefaultTimeout(30000)
  console.log(`WebView: ${await page.evaluate(() => navigator.userAgent)}`)

  await page.goto('https://localhost/?view=settings')
  await page.getByRole('textbox', { name: 'Server URL' }).fill(base)
  await page.getByRole('textbox', { name: 'Access token' }).fill(token)
  // The form's own Connect button, found through the form: the page has more than one.
  await page.getByRole('textbox', { name: 'Server URL' }).evaluate((el) => [...el.form.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connect').click())
  await page.getByRole('button', { name: 'Disconnect' }).waitFor()
  await page.goto('https://localhost/?view=mytasks')
  await page.getByText('Clock order check', { exact: true }).first().waitFor()
  await page.getByText('Clock time check', { exact: true }).first().waitFor()
  note('the app connects to the scratch server and lists the tasks', true)

  const editTitle = async (from, to) => {
    await page.getByRole('button', { name: `Open ${from}`, exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.waitFor()
    const field = panel.getByRole('textbox', { name: 'Task title' })
    await field.fill(to)
    await field.press('Tab')
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: `Open ${to}`, exact: true }).waitFor()
  }
  const serverTask = async (id) => api('GET', `/api/tasks/${id}`)
  const deviceNow = () => page.evaluate(() => Date.now())

  // A task's panel opens offline only from the app's stored copy of that task, which the app
  // fills in the background after it connects. Opening each task once while online puts it there
  // for certain, so the offline edits below do not depend on how far that had got.
  for (const title of ['Clock order check', 'Clock time check']) {
    await page.getByRole('button', { name: `Open ${title}`, exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('textbox', { name: 'Task title' }).waitFor()
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })
  }
  note('each task opens while online, so the app has its own copy of it', true)

  // The app stores a reading of the server's clock (cc-server-clock-v1) with each events poll, every
  // ten seconds, while online and with nothing waiting to be sent. Read the one for this server.
  const clockSample = () => page.evaluate((origin) => {
    try {
      return JSON.parse(localStorage.getItem('cc-server-clock-v1') || '{}')[origin]?.sample ?? null
    } catch {
      return null
    }
  }, new URL(base).origin)
  const firstReading = await until('first clock reading', async () => {
    const sample = await clockSample()
    return { done: Boolean(sample), sample }
  }, 40000)
  note('the app took a reading of the server clock while online', firstReading.done, JSON.stringify(firstReading.sample))

  // 1. Order: two edits to one field offline, with the clock set back between them.
  await offline()
  const sawOffline = await page.getByRole('status').filter({ hasText: 'Offline.' }).waitFor({ timeout: 40000 }).then(() => true, () => false)
  note('the app shows it is offline', sawOffline)
  await editTitle('Clock order check', 'Order A')
  const hostBefore = Date.now()
  clockTouched = true
  adb('shell', 'date', `@${Math.floor(Date.now() / 1000) + SKEW_SECONDS}`)
  await sleep(1500)
  const skew = (await deviceNow()) - hostBefore
  note('the WebView sees the changed clock', Math.abs(skew - SKEW_SECONDS * 1000) < 30000, `${Math.round(skew / 1000)} s`)
  await editTitle('Order A', 'Order B')
  const queued = await page.evaluate(() => new Promise((resolveQueue) => {
    const open = indexedDB.open('cc-outbox-v1')
    open.onerror = () => resolveQueue({ error: 'cannot open the queue' })
    open.onsuccess = () => {
      const db = open.result
      const store = db.transaction(db.objectStoreNames[0], 'readonly').objectStore(db.objectStoreNames[0])
      const keys = store.getAllKeys()
      const values = store.getAll()
      values.onsuccess = () => resolveQueue(keys.result.map((k, i) => ({ key: k, at: values.result[i]?.at, title: values.result[i]?.body?.title })))
    }
  }))
  const ops = queued.filter?.((q) => q.title) ?? []
  // A key is the milliseconds (never lower than the last key's, so the clock going back cannot
  // reorder), a sequence, and this page's id (outbox.js, nextQueueKey).
  const keyShape = /^\d{15}-\d{6}-[0-9a-z]+$/
  note('the queue holds both edits under ordered keys, in the order made', ops.length === 2 && ops[0].title === 'Order A' && ops[1].title === 'Order B' && ops.every((o) => keyShape.test(o.key)) && ops[0].key < ops[1].key, ops.map((o) => `${o.key}=${o.title}@${o.at}`).join(' '))
  note('the second edit carries the EARLIER device time (the clock went back)', ops.length === 2 && Date.parse(ops[1].at) < Date.parse(ops[0].at))
  online()
  const order = await until('order flush', async () => {
    const { task } = await serverTask(orderTask.id)
    return { done: task.title === 'Order B', title: task.title }
  }, 60000)
  note('after reconnecting the server ends on the edit made last ("Order B")', order.done, `server title: ${order.title}`)
  const orderHistory = (await serverTask(orderTask.id)).history ?? []
  note('no conflict was recorded for one device editing its own field', !orderHistory.some((e) => e.kind === 'task.sync_conflict'))

  // 2. Time: the device is ten minutes behind. A live edit, then a later offline edit to the
  // same field. The offline edit is the newer one and must win.
  const sawOnline = await page.getByRole('status').filter({ hasText: 'Offline.' }).waitFor({ state: 'hidden', timeout: 40000 }).then(() => true, () => false)
  note('the app shows it is back online', sawOnline)
  // A new reading, taken with the device ten minutes behind: the server is ten minutes ahead of it.
  const behindReading = await until('clock reading while behind', async () => {
    const sample = await clockSample()
    return { done: Math.abs((sample?.offsetMs ?? 0) - -SKEW_SECONDS * 1000) < 60000, sample }
  }, 60000)
  note('the app took a new clock reading while the device was ten minutes behind', behindReading.done, JSON.stringify(behindReading.sample))
  await offline()
  await api('PATCH', `/api/tasks/${timeTask.id}`, { title: 'Laptop edit' })
  await sleep(3000)
  await editTitle('Clock time check', 'Phone edit')
  online()
  const time = await until('time flush', async () => {
    const data = await serverTask(timeTask.id)
    const conflict = (data.history ?? []).find((e) => e.kind === 'task.sync_conflict')
    return { done: Boolean(conflict), title: data.task.title, conflict: conflict?.payload }
  }, 60000)
  note('a later offline edit from a device ten minutes behind wins over the earlier live edit', time.done && time.title === 'Phone edit', `server title: ${time.title}; conflict: ${JSON.stringify(time.conflict)}`)
  note('the losing live edit is kept in the history', time.done && time.conflict?.discarded === 'Laptop edit' && time.conflict?.kept === 'Phone edit')

  // 3. The About card, once a poll has taken a reading with the changed clock.
  await page.goto('https://localhost/?view=settings')
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'About' }).click()
  const card = page.getByRole('region', { name: 'About' })
  const row = await until('clock row', async () => {
    const text = await card.innerText()
    return { done: /10 minutes behind the server's clock/.test(text), text }
  }, 40000)
  note('the About card reads "10 minutes behind the server\'s clock"', row.done, row.text?.replace(/\s+/g, ' ').slice(0, 300))
  const notice = await card.getByRole('status').innerText().catch(() => '')
  note('the notice is shown', notice.length > 0, notice.replace(/\s+/g, ' '))
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'app-about-clock.png') }).catch((err) => console.error(`Screenshot failed: ${err.message}`))

} catch (err) {
  note('the check ran to the end', false, String(err?.stack || err).slice(0, 600))
} finally {
  try {
    await device?.close()
  } catch {
    // Already gone.
  }
  cleanup()
}
const restored = restoreProblems.size === 0
note("the emulator's clock and automatic time were restored", restored, restored ? undefined : `not restored: ${[...restoreProblems].join(', ')}; see the commands printed above`)
status = results.every(Boolean) ? 0 : 1
console.log(`\nOffline queue check on ${serial}:\n${lines.join('\n')}`)
console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`)
process.exit(status)
