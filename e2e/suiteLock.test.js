// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSuiteLock, pidAlive, readLock, TOKEN_ENV } from './suiteLock.js'

let dir
let path
const held = []
const fast = { pollMs: 5, noticeMs: 0, heartbeatMs: 10_000, env: {} }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suite-lock-test-'))
  path = join(dir, 'suite.lock')
})
afterEach(() => {
  for (const lock of held.splice(0)) lock.release()
  rmSync(dir, { recursive: true, force: true })
})

async function take(opts = {}) {
  const lock = await acquireSuiteLock({ path, log: () => {}, ...fast, ...opts })
  held.push(lock)
  return lock
}

function writeHeld(record, mtime = new Date()) {
  writeFileSync(path, JSON.stringify({ token: 'other', startedAt: '2026-11-03T10:00:00.000Z', command: 'playwright test', ...record }))
  utimesSync(path, mtime, mtime)
}

describe('the UI suite lock', () => {
  test('a free lock is taken at once and names its holder; release lets it go', async () => {
    const lock = await take({ command: 'playwright test --project desktop' })
    expect(lock.reentrant).toBe(false)
    expect(readLock(path)).toMatchObject({ token: lock.token, pid: process.pid, command: 'playwright test --project desktop' })
    expect(Number.isNaN(Date.parse(readLock(path).startedAt))).toBe(false)
    lock.release()
    expect(existsSync(path)).toBe(false)
  })

  test('a second run waits while the first holds it, says why, and goes once it is released', async () => {
    const first = await take({ command: 'first run' })
    const log = vi.fn()
    let second = null
    const waiting = take({ log, command: 'second run' }).then((lock) => { second = lock })
    await new Promise((done) => setTimeout(done, 60))
    expect(second).toBeNull()
    expect(log).toHaveBeenCalled()
    expect(log.mock.calls[0][0]).toContain(`pid ${process.pid}`)
    expect(log.mock.calls[0][0]).toContain('first run')
    expect(log.mock.calls[0][0]).toContain('Waiting for it to finish')
    first.release()
    await waiting
    expect(readLock(path).token).toBe(second.token)
  })

  test('a lock whose process is gone is cleared', async () => {
    writeHeld({ pid: 999_999_999 })
    const lock = await take({ isAlive: () => false })
    expect(readLock(path).token).toBe(lock.token)
  })

  test('a lock not touched for longer than staleMs is cleared even if its pid now belongs to another process', async () => {
    writeHeld({ pid: process.pid }, new Date(Date.now() - 10 * 60 * 1000))
    const lock = await take({ staleMs: 5 * 60 * 1000 })
    expect(readLock(path).token).toBe(lock.token)
  })

  test('a lock that is fresh and alive is not cleared', async () => {
    writeHeld({ pid: process.pid })
    const log = vi.fn()
    const pending = acquireSuiteLock({ path, ...fast, log })
    await new Promise((done) => setTimeout(done, 40))
    expect(readLock(path).token).toBe('other')
    expect(log).toHaveBeenCalled()
    rmSync(path)
    held.push(await pending)
  })

  test('an unreadable lock file is waited on while new, and cleared once older than tornMs', async () => {
    writeFileSync(path, '')
    const old = new Date(Date.now() - 60 * 1000)
    utimesSync(path, old, old)
    const lock = await take({ tornMs: 10_000 })
    expect(readLock(path).token).toBe(lock.token)
  })

  test('a run started by the holder, with its token, goes on under the same lock and leaves it held', async () => {
    const outer = await take()
    const inner = await take({ env: { [TOKEN_ENV]: outer.token } })
    expect(inner).toMatchObject({ token: outer.token, reentrant: true })
    inner.release()
    expect(readLock(path).token).toBe(outer.token)
  })

  test('a token that does not match the lock held does not let a run in', async () => {
    await take()
    let inner = null
    const pending = acquireSuiteLock({ path, ...fast, log: () => {}, env: { [TOKEN_ENV]: 'stale-token' } }).then((l) => { inner = l })
    await new Promise((done) => setTimeout(done, 40))
    expect(inner).toBeNull()
    held.splice(0).forEach((l) => l.release())
    await pending
    held.push(inner)
    expect(inner.reentrant).toBe(false)
  })

  test('the holder keeps the lock fresh', async () => {
    const lock = await take({ heartbeatMs: 10 })
    const old = new Date(Date.now() - 60 * 1000)
    utimesSync(path, old, old)
    await new Promise((done) => setTimeout(done, 60))
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(5000)
    expect(readLock(path).token).toBe(lock.token)
  })

  test('release never removes a lock someone else now holds', async () => {
    const lock = await take()
    writeHeld({ pid: process.pid, token: 'newer' })
    lock.release()
    expect(readLock(path).token).toBe('newer')
  })

  test('pidAlive tells this process from a pid that does not exist', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(999_999_999)).toBe(false)
    expect(pidAlive(0)).toBe(false)
  })
})
