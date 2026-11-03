import { linkSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// One UI suite at a time on this machine. Each run starts a server and a browser per worker (eight
// by default), so two runs side by side, say the main checkout's and an agent worktree's, keep
// half of a 32-core machine busy and make both slow. The lock is a file in the system temp
// directory, outside any checkout, so every checkout and worktree sees the same one.
//
// Taking it is an exclusive create, so two runs that start together cannot both win. The file
// names its holder (pid, start time, command), and the holder touches it every `heartbeatMs`. A
// waiter clears the lock when its pid is gone, or when the file has not been touched for
// `staleMs` (the pid has been reused by another process since the holder died). Anything else
// waits, saying who it is waiting for.
//
// A run that holds the lock passes its token to the processes it starts in CC_UI_SUITE_LOCK, so
// `npm run test:ui` (scripts/suite-lock.mjs) and `npm run shots` take it before they build, and
// the Playwright run they start goes on under the same lock (playwright.config.js, which takes
// it as the config loads) instead of waiting for itself.

export const LOCK_PATH = process.env.CC_UI_LOCK_FILE || join(tmpdir(), 'polaris-ui-suite.lock')
export const TOKEN_ENV = 'CC_UI_SUITE_LOCK'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Whether a process with this pid exists (EPERM: it does, but belongs to someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** The lock's record, or null when there is none or it cannot be read (being written, or torn). */
export function readLock(path = LOCK_PATH) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    return record && typeof record.token === 'string' ? record : null
  } catch {
    return null
  }
}

function ageMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return 0
  }
}

// Move the lock aside, then delete it only if it is still the one judged stale. If another
// waiter replaced it in between, put the new one back (a link never overwrites an existing file).
function clearStale(path, judged) {
  const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.stale`
  try {
    renameSync(path, aside)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  const moved = readLock(aside)
  if ((moved?.token ?? null) !== (judged?.token ?? null)) {
    try { linkSync(aside, path) } catch { /* a newer lock is already in place */ }
  }
  try { unlinkSync(aside) } catch { /* gone already */ }
}

function describe(held, path, waitedMs) {
  const who = held
    ? `pid ${held.pid}, started ${held.startedAt}${held.cwd ? ` in ${held.cwd}` : ''}: ${held.command || 'unknown command'}`
    : 'a run that is still writing the lock file'
  const waited = waitedMs >= 1000 ? ` Waited ${Math.round(waitedMs / 1000)}s so far.` : ''
  return `Another UI test run holds the suite lock (${who}). Waiting for it to finish, because two suites at once overload the machine (lock file: ${path}).${waited}`
}

function touch(path, token) {
  if (readLock(path)?.token !== token) return
  const now = new Date()
  try { utimesSync(path, now, now) } catch { /* released meanwhile */ }
}

function releaseIfOwned(path, token) {
  if (readLock(path)?.token !== token) return
  try { unlinkSync(path) } catch { /* gone already */ }
}

/**
 * Take the suite lock, waiting as long as another live run holds it. Resolves to
 * `{ token, reentrant, release }`. With `env[TOKEN_ENV]` naming the lock that is held, this run
 * was started by the holder: it does not wait, keeps the lock fresh, and its release leaves the
 * lock to the holder.
 */
export async function acquireSuiteLock({
  path = LOCK_PATH,
  command = process.argv.slice(1).join(' '),
  env = process.env,
  pollMs = 1000,
  noticeMs = 30000,
  heartbeatMs = 15000,
  staleMs = 5 * 60 * 1000,
  tornMs = 10000,
  isAlive = pidAlive,
  log = (line) => console.log(line),
} = {}) {
  const heartbeat = (token) => {
    const timer = setInterval(() => touch(path, token), heartbeatMs)
    timer.unref?.()
    return timer
  }

  const inherited = env[TOKEN_ENV]
  if (inherited && readLock(path)?.token === inherited) {
    const timer = heartbeat(inherited)
    return { token: inherited, reentrant: true, release: () => clearInterval(timer) }
  }

  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
  const record = { token, pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd(), command }
  const started = Date.now()
  let noticed = -Infinity
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify(record), { flag: 'wx' })
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const held = readLock(path)
    const age = ageMs(path)
    const stale = held ? !isAlive(held.pid) || age > staleMs : age > tornMs
    if (stale) {
      clearStale(path, held)
      continue
    }
    if (Date.now() - noticed >= noticeMs) {
      log(describe(held, path, Date.now() - started))
      noticed = Date.now()
    }
    await sleep(pollMs)
  }

  const timer = heartbeat(token)
  const onExit = () => releaseIfOwned(path, token)
  process.on('exit', onExit)
  return {
    token,
    reentrant: false,
    release() {
      clearInterval(timer)
      process.off('exit', onExit)
      releaseIfOwned(path, token)
    },
  }
}
