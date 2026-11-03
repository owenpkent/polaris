import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
// `npm run test:ui` (scripts/test-ui.mjs) and `npm run shots` take it before they build, and
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

// Removing the lock file goes through a second, short-lived mutex file, `<lock>.reclaim`, created
// exclusively and holding the pid and time of its owner. Only the owner of the mutex may remove the
// lock file, whether it is reclaiming a lock it judged stale or releasing its own: it re-reads the
// lock under the mutex and removes it only if it is still the one it meant to remove. Taking the
// lock stays an exclusive create of the lock path, which cannot succeed while any lock file exists,
// so a lock replaced by a live successor between a contender's inspection and its removal is
// left alone. A mutex left by a dead process is cleared when its pid is gone or it is older than
// `mutexStaleMs`. Residual window: clearing an abandoned mutex is itself an unlink, so two
// contenders clearing the same dead mutex can in theory delete a third's fresh one; the mutex is
// held for microseconds and only a process that died inside that window leaves one, so we accept it.

const MUTEX_STALE_MS = 5000
const MUTEX_WAIT_MS = 2000

const reclaimPath = (path) => `${path}.reclaim`

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readMutex(mutex) {
  try {
    return JSON.parse(readFileSync(mutex, 'utf8'))
  } catch {
    return null
  }
}

/** Run `fn` while holding the reclaim mutex. Returns `{ held: false }` when it could not be taken in time. */
function withMutex(path, { isAlive = pidAlive, mutexStaleMs = MUTEX_STALE_MS, mutexWaitMs = MUTEX_WAIT_MS } = {}, fn) {
  const mutex = reclaimPath(path)
  const mine = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: randomBytes(4).toString('hex') })
  const deadline = Date.now() + mutexWaitMs
  for (;;) {
    try {
      writeFileSync(mutex, mine, { flag: 'wx' })
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const other = readMutex(mutex)
    const age = ageMs(mutex)
    const abandoned = other ? !isAlive(other.pid) || age > mutexStaleMs : age > mutexStaleMs
    if (abandoned) {
      // Only remove the very mutex that was judged.
      if ((readMutex(mutex)?.nonce ?? null) === (other?.nonce ?? null)) {
        try { unlinkSync(mutex) } catch { /* gone already */ }
      }
      continue
    }
    if (Date.now() >= deadline) return { held: false }
    pause(2)
  }
  try {
    return { held: true, value: fn() }
  } finally {
    if (readMutex(mutex)?.nonce === JSON.parse(mine).nonce) {
      try { unlinkSync(mutex) } catch { /* gone already */ }
    }
  }
}

/**
 * Remove the lock file if, read again under the reclaim mutex, `shouldRemove(record)` still holds
 * (record is null for an unreadable file). Returns whether it was removed.
 */
export function removeLockIf(path, shouldRemove, opts = {}) {
  const result = withMutex(path, opts, () => {
    const record = readLock(path)
    if (!shouldRemove(record)) return false
    try { unlinkSync(path) } catch (err) { if (err.code !== 'ENOENT') throw err }
    return true
  })
  return result.held ? result.value : false
}

export { reclaimPath }

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

function releaseIfOwned(path, token, opts) {
  if (readLock(path)?.token !== token) return
  removeLockIf(path, (record) => record?.token === token, opts)
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
      // The judged record, or for an unreadable file one still unreadable and still old.
      removeLockIf(
        path,
        held
          ? (now) => now?.token === held.token && (!isAlive(now.pid) || ageMs(path) > staleMs)
          : (now) => now === null && ageMs(path) > tornMs,
        { isAlive },
      )
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
