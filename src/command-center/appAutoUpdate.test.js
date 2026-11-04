import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  APP_UPDATE_PREFS_KEY, APP_UPDATE_CHANGED_EVENT, CHECK_INTERVAL_MS,
  readAppUpdatePrefs, saveAppUpdatePrefs, isCheckDue, runAppUpdateCheck, installReadyUpdate,
} from './appAutoUpdate'

const URL = 'https://github.com/owenpkent/polaris/releases/download/v2.4.0/polaris-2.4.0.apk'
const APK = { name: 'polaris-2.4.0.apk', browser_download_url: URL, size: 4348073 }
const NOW = new Date('2026-11-04T12:00:00Z')

function release(over = {}) {
  return { tag_name: 'v2.4.0', draft: false, prerelease: false, assets: [APK], ...over }
}

function fakeFetch(body, status = 200) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
}

function fakeBridge(over = {}) {
  return {
    download: vi.fn(async () => ({ path: '/cache/updates/polaris-2.4.0.apk', size: 4348073 })),
    verify: vi.fn(async () => ({ ok: true, packageName: 'com.okstudio.polaris', versionName: '2.4.0', versionCode: 20400, sameSigner: true })),
    canInstall: vi.fn(async () => true),
    openInstallSettings: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    cancelNotification: vi.fn(async () => {}),
    ...over,
  }
}

const READY = { version: '2.4.0', path: '/cache/updates/polaris-2.4.0.apk', name: 'polaris-2.4.0.apk' }

function store(prefs) {
  saveAppUpdatePrefs({ enabled: true, lastCheckedAt: null, ready: null, lastError: null, ...prefs })
}

beforeEach(() => {
  localStorage.clear()
})

describe('prefs', () => {
  test('default to on, never checked, nothing ready', () => {
    expect(readAppUpdatePrefs()).toEqual({ enabled: true, lastCheckedAt: null, ready: null, lastError: null })
  })

  test('save stores them and tells the window', () => {
    const seen = vi.fn()
    window.addEventListener(APP_UPDATE_CHANGED_EVENT, seen)
    saveAppUpdatePrefs({ enabled: false, lastCheckedAt: NOW.toISOString(), ready: READY, lastError: null })
    window.removeEventListener(APP_UPDATE_CHANGED_EVENT, seen)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(APP_UPDATE_PREFS_KEY)).enabled).toBe(false)
    expect(readAppUpdatePrefs()).toEqual({ enabled: false, lastCheckedAt: NOW.toISOString(), ready: READY, lastError: null })
  })

  test('garbage falls back to the defaults', () => {
    localStorage.setItem(APP_UPDATE_PREFS_KEY, '{nope')
    expect(readAppUpdatePrefs().enabled).toBe(true)
    localStorage.setItem(APP_UPDATE_PREFS_KEY, JSON.stringify({ ready: { version: 5 }, lastCheckedAt: 'x' }))
    expect(readAppUpdatePrefs()).toEqual({ enabled: true, lastCheckedAt: null, ready: null, lastError: null })
  })
})

describe('isCheckDue', () => {
  test('due on the first run, after six hours, or when forced', () => {
    expect(isCheckDue({ lastCheckedAt: null }, NOW)).toBe(true)
    const recent = new Date(NOW.getTime() - CHECK_INTERVAL_MS + 1000).toISOString()
    const old = new Date(NOW.getTime() - CHECK_INTERVAL_MS).toISOString()
    expect(isCheckDue({ lastCheckedAt: recent }, NOW)).toBe(false)
    expect(isCheckDue({ lastCheckedAt: old }, NOW)).toBe(true)
    expect(isCheckDue({ lastCheckedAt: recent }, NOW, { force: true })).toBe(true)
  })
})

describe('runAppUpdateCheck', () => {
  test('a newer release is downloaded, verified, announced and recorded as ready', async () => {
    const bridge = fakeBridge()
    const res = await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl: fakeFetch(release()), bridge })
    expect(res).toEqual({ state: 'newer', latest: '2.4.0' })
    expect(bridge.download).toHaveBeenCalledWith({ url: URL, name: 'polaris-2.4.0.apk', size: 4348073 })
    expect(bridge.verify).toHaveBeenCalledWith(READY.path)
    expect(bridge.notify).toHaveBeenCalledWith({ version: '2.4.0' })
    expect(bridge.install).not.toHaveBeenCalled()
    expect(readAppUpdatePrefs()).toEqual({ enabled: true, lastCheckedAt: NOW.toISOString(), ready: READY, lastError: null })
  })

  test('a file that fails the check is discarded, recorded as an error, and never installed', async () => {
    const bridge = fakeBridge({ verify: vi.fn(async () => ({ ok: false, sameSigner: false })) })
    const res = await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl: fakeFetch(release()), bridge })
    expect(res.error).toMatch(/not Polaris signed/)
    expect(bridge.discard).toHaveBeenCalled()
    expect(bridge.cancelNotification).toHaveBeenCalled()
    expect(bridge.notify).not.toHaveBeenCalled()
    expect(bridge.install).not.toHaveBeenCalled()
    const prefs = readAppUpdatePrefs()
    expect(prefs.ready).toBeNull()
    expect(prefs.lastError).toMatch(/not Polaris signed/)
    expect(prefs.lastCheckedAt).toBe(NOW.toISOString())
  })

  test('a download that throws is recorded and leaves no ready file', async () => {
    const bridge = fakeBridge({ download: vi.fn(async () => { throw new Error('Download failed.') }) })
    await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl: fakeFetch(release()), bridge })
    expect(readAppUpdatePrefs().lastError).toBe('Download failed.')
    expect(readAppUpdatePrefs().ready).toBeNull()
    expect(bridge.discard).toHaveBeenCalled()
  })

  test('a ready file for the same version that still verifies is kept, not downloaded again', async () => {
    store({ ready: READY })
    const bridge = fakeBridge()
    await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl: fakeFetch(release()), bridge })
    expect(bridge.download).not.toHaveBeenCalled()
    expect(bridge.notify).not.toHaveBeenCalled()
    expect(readAppUpdatePrefs().ready).toEqual(READY)
  })

  test('a ready file that no longer verifies is downloaded again', async () => {
    store({ ready: READY })
    const verify = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true })
    const bridge = fakeBridge({ verify })
    await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl: fakeFetch(release()), bridge })
    expect(bridge.download).toHaveBeenCalledTimes(1)
    expect(readAppUpdatePrefs().ready).toEqual(READY)
  })

  test('current clears a ready file, discards it and cancels the notification', async () => {
    store({ ready: READY })
    const bridge = fakeBridge()
    const res = await runAppUpdateCheck({ running: '2.4.0', now: NOW, fetchImpl: fakeFetch(release()), bridge })
    expect(res.state).toBe('current')
    expect(bridge.discard).toHaveBeenCalled()
    expect(bridge.cancelNotification).toHaveBeenCalled()
    expect(bridge.download).not.toHaveBeenCalled()
    expect(readAppUpdatePrefs().ready).toBeNull()
  })

  test('no apk and unknown download nothing and clear ready', async () => {
    for (const body of [release({ assets: [] }), release({ tag_name: 'nightly' })]) {
      store({ ready: READY })
      const bridge = fakeBridge()
      await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl: fakeFetch(body), bridge })
      expect(bridge.download).not.toHaveBeenCalled()
      expect(bridge.discard).toHaveBeenCalled()
      expect(readAppUpdatePrefs().ready).toBeNull()
    }
  })

  test('a release check that fails keeps a ready file and records the error', async () => {
    store({ ready: READY })
    const bridge = fakeBridge()
    await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl: fakeFetch({}, 403), bridge })
    expect(bridge.discard).not.toHaveBeenCalled()
    const prefs = readAppUpdatePrefs()
    expect(prefs.ready).toEqual(READY)
    expect(prefs.lastError).toBe('GitHub did not answer (HTTP 403).')
  })

  test('with the setting off nothing is asked, unless the owner forces a check', async () => {
    store({ enabled: false })
    const fetchImpl = fakeFetch(release())
    const bridge = fakeBridge()
    expect(await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl, bridge })).toEqual({ skipped: 'disabled' })
    expect(fetchImpl).not.toHaveBeenCalled()
    await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl, bridge, force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(readAppUpdatePrefs().enabled).toBe(false)
  })

  test('a check that is not due is skipped, and force overrides it', async () => {
    store({ lastCheckedAt: NOW.toISOString() })
    const fetchImpl = fakeFetch(release({ tag_name: 'v2.3.0' }))
    const bridge = fakeBridge()
    expect(await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl, bridge })).toEqual({ skipped: 'not-due' })
    expect(fetchImpl).not.toHaveBeenCalled()
    await runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl, bridge, force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('a second call while one runs shares its answer', async () => {
    const fetchImpl = fakeFetch(release({ tag_name: 'v2.3.0' }))
    const bridge = fakeBridge()
    const a = runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl, bridge })
    const b = runAppUpdateCheck({ running: '2.3.0', now: NOW, fetchImpl, bridge, force: true })
    expect(b).toBe(a)
    await a
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('installReadyUpdate', () => {
  test('opens the installer when Android allows it', async () => {
    store({ ready: READY })
    const bridge = fakeBridge()
    expect(await installReadyUpdate({ bridge })).toEqual({ opened: 'installer' })
    expect(bridge.install).toHaveBeenCalledWith(READY.path)
    expect(bridge.openInstallSettings).not.toHaveBeenCalled()
  })

  test('opens the settings page instead when Android has not allowed it', async () => {
    store({ ready: READY })
    const bridge = fakeBridge({ canInstall: vi.fn(async () => false) })
    expect(await installReadyUpdate({ bridge })).toEqual({ opened: 'settings' })
    expect(bridge.openInstallSettings).toHaveBeenCalledTimes(1)
    expect(bridge.install).not.toHaveBeenCalled()
  })

  test('refuses when nothing is ready', async () => {
    const bridge = fakeBridge()
    await expect(installReadyUpdate({ bridge })).rejects.toThrow()
    expect(bridge.install).not.toHaveBeenCalled()
  })
})
