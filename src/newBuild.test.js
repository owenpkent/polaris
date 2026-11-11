import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { CHECK_INTERVAL_MS, busy, currentEntry, entryFromHtml, watchForNewBuild } from './newBuild'
import { createApiClient } from './command-center/api'
import { memoryBackend, setCacheBackend } from './command-center/offlineCache'
import { setOutboxBackend } from './command-center/outbox'
import { resetOfflineStatus } from './command-center/offlineStatus'

const page = (entry) => `<!DOCTYPE html><html><head><script>var x = 1</script>
<script type="module" crossorigin src="${entry}"></script></head><body></body></html>`

let hidden = false
let stop

function setHidden(value) {
  hidden = value
  document.dispatchEvent(new Event('visibilitychange'))
}

function serving(entry) {
  return vi.fn(async () => ({ ok: true, text: async () => page(entry) }))
}

// Lets the check's awaits run.
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  const script = document.createElement('script')
  script.type = 'module'
  script.src = '/assets/index-OLD.js'
  document.head.appendChild(script)
  sessionStorage.clear()
})

afterEach(() => {
  stop?.()
  stop = undefined
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  delete document.hidden
  vi.useRealTimers()
})

describe('entryFromHtml', () => {
  test('finds the hashed module entry and skips inline scripts', () => {
    expect(entryFromHtml(page('/assets/index-C-TWUjnK.js'))).toBe('/assets/index-C-TWUjnK.js')
  })

  test('a page with no entry, or no page, names no build', () => {
    expect(entryFromHtml('<html><script src="/other.js"></script></html>')).toBe(null)
    expect(entryFromHtml('')).toBe(null)
    expect(entryFromHtml(undefined)).toBe(null)
  })
})

describe('currentEntry', () => {
  test('is the build this page loaded', () => {
    expect(currentEntry()).toBe('/assets/index-OLD.js')
  })
})

describe('busy', () => {
  test('an open dialog or a field holding text holds the reload', () => {
    expect(busy()).toBe(false)
    document.body.innerHTML = '<div role="dialog" aria-label="Task"></div>'
    expect(busy()).toBe(true)
    document.body.innerHTML = '<input value="">'
    expect(busy()).toBe(false)
    document.body.innerHTML = '<textarea>half a note</textarea>'
    expect(busy()).toBe(true)
    document.body.innerHTML = '<input type="checkbox" value="on">'
    expect(busy()).toBe(false)
    // A name box between Enter and the save: read-only, so not a field being typed in, but its
    // text is not saved yet (review on #165).
    document.body.innerHTML = '<input readonly aria-busy="true" value="Buy milk">'
    expect(busy()).toBe(true)
    document.body.innerHTML = '<input aria-busy="false" value="">'
    expect(busy()).toBe(false)
  })
})

describe('watchForNewBuild', () => {
  test('a hidden tab reloads when the server serves a new build', async () => {
    const reload = vi.fn()
    stop = watchForNewBuild({ fetchImpl: serving('/assets/index-NEW.js'), reload })
    setHidden(true)
    await settle()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('a visible tab is never reloaded and never asks', async () => {
    const reload = vi.fn()
    const fetchImpl = serving('/assets/index-NEW.js')
    stop = watchForNewBuild({ fetchImpl, reload })
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test('the same build, or a server that cannot be reached, leaves the tab alone and checks again', async () => {
    const reload = vi.fn()
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, text: async () => page('/assets/index-OLD.js') })
      .mockResolvedValue({ ok: true, text: async () => page('/assets/index-NEW.js') })
    stop = watchForNewBuild({ fetchImpl, reload })
    setHidden(true)
    await settle()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('an unsaved edit holds the reload until it is gone', async () => {
    const reload = vi.fn()
    document.body.innerHTML = '<input value="Buy milk">'
    stop = watchForNewBuild({ fetchImpl: serving('/assets/index-NEW.js'), reload })
    setHidden(true)
    await settle()
    expect(reload).not.toHaveBeenCalled()
    document.body.innerHTML = ''
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  // Review on #165: a write still out is not in the outbox yet, so a reload then would lose it.
  test('a write still out holds the reload until it is answered', async () => {
    setCacheBackend(memoryBackend())
    setOutboxBackend(memoryBackend())
    resetOfflineStatus()
    let answer
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    try {
      const api = createApiClient('http://127.0.0.1:8788', 'token')
      const saved = api.createTask({ title: 'Buy milk' })
      const reload = vi.fn()
      stop = watchForNewBuild({ fetchImpl: serving('/assets/index-NEW.js'), reload })
      setHidden(true)
      await settle()
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
      expect(reload).not.toHaveBeenCalled()

      answer({ ok: true, status: 201, text: async () => JSON.stringify({ task: { id: 't1', title: 'Buy milk' } }) })
      await saved
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('showing the tab stops the checks', async () => {
    const reload = vi.fn()
    const fetchImpl = serving('/assets/index-OLD.js')
    stop = watchForNewBuild({ fetchImpl, reload })
    setHidden(true)
    await settle()
    setHidden(false)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('an answer that lands after the tab is shown does not reload it', async () => {
    const reload = vi.fn()
    let answer
    const fetchImpl = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    stop = watchForNewBuild({ fetchImpl, reload })
    setHidden(true)
    await settle()
    setHidden(false)
    answer({ ok: true, text: async () => page('/assets/index-NEW.js') })
    await settle()
    expect(reload).not.toHaveBeenCalled()
  })

  test('a build the tab already reloaded for is not reloaded for again', async () => {
    const reload = vi.fn()
    sessionStorage.setItem('cc-reloaded-for-build', '/assets/index-NEW.js')
    stop = watchForNewBuild({ fetchImpl: serving('/assets/index-NEW.js'), reload })
    setHidden(true)
    await settle()
    expect(reload).not.toHaveBeenCalled()
  })
})
