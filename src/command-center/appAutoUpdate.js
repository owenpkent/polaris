// The Android app's own update flow: when to check, what to do with the answer, and the install
// hand-off. Pure of React. The answer comes from appUpdate.js (GitHub's public releases API, no
// credential); the download, the check of the file and the installer are the shell's AppUpdater
// plugin, reached through the nativeApp.js wrappers. Android always asks the owner once to confirm.
import { checkForAppUpdate } from './appUpdate'
import * as native from './nativeApp'

export const APP_UPDATE_PREFS_KEY = 'cc-app-update-v1'
export const APP_UPDATE_CHANGED_EVENT = 'cc-app-update-changed'
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
export const DEFAULT_APP_UPDATE_PREFS = { enabled: true, lastCheckedAt: null, ready: null, lastError: null }

const text = (v) => (typeof v === 'string' && v ? v : null)

export function readAppUpdatePrefs() {
  try {
    const raw = localStorage.getItem(APP_UPDATE_PREFS_KEY)
    if (!raw) return { ...DEFAULT_APP_UPDATE_PREFS }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_APP_UPDATE_PREFS }
    const r = parsed.ready
    const ready = r && typeof r === 'object' && text(r.version) && text(r.path) && text(r.name)
      ? { version: r.version, path: r.path, name: r.name }
      : null
    return {
      enabled: parsed.enabled !== false,
      lastCheckedAt: Number.isFinite(Date.parse(parsed.lastCheckedAt)) ? parsed.lastCheckedAt : null,
      ready,
      lastError: text(parsed.lastError),
    }
  } catch {
    return { ...DEFAULT_APP_UPDATE_PREFS }
  }
}

export function saveAppUpdatePrefs(prefs) {
  try {
    localStorage.setItem(APP_UPDATE_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
  try {
    window.dispatchEvent(new Event(APP_UPDATE_CHANGED_EVENT))
  } catch {
    // No window to tell.
  }
}

// Due on the first run, six hours after the last check, or when the owner asks (force).
export function isCheckDue(prefs, now = new Date(), { force = false } = {}) {
  if (force) return true
  const last = Date.parse(prefs?.lastCheckedAt)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= CHECK_INTERVAL_MS || now.getTime() < last
}

const defaultBridge = {
  download: (...a) => native.downloadAppUpdate(...a),
  verify: (...a) => native.verifyAppUpdate(...a),
  canInstall: (...a) => native.canInstallApps(...a),
  openInstallSettings: (...a) => native.openInstallSettings(...a),
  install: (...a) => native.installAppUpdate(...a),
  discard: (...a) => native.discardAppUpdate(...a),
  notify: (...a) => native.scheduleAppUpdateNotification(...a),
  cancelNotification: (...a) => native.cancelAppUpdateNotification(...a),
}

async function quietly(fn) {
  try {
    await fn()
  } catch {
    // Cleanup that fails changes nothing the owner can act on.
  }
}

// Merges a change into the stored prefs as they are now, so a toggle made while a check ran stays.
function patch(change) {
  const next = { ...readAppUpdatePrefs(), ...change }
  saveAppUpdatePrefs(next)
  return next
}

let inFlight = null

// One check at a time: a call while one runs gets that run's answer. Resolves to
// { skipped: 'disabled' | 'not-due' } or { state, latest }, or { error }.
export function runAppUpdateCheck({ running, now = new Date(), force = false, fetchImpl, bridge = defaultBridge } = {}) {
  if (inFlight) return inFlight
  inFlight = doCheck({ running, now, force, fetchImpl, bridge }).finally(() => { inFlight = null })
  return inFlight
}

async function doCheck({ running, now, force, fetchImpl, bridge }) {
  const prefs = readAppUpdatePrefs()
  if (!prefs.enabled && !force) return { skipped: 'disabled' }
  if (!isCheckDue(prefs, now, { force })) return { skipped: 'not-due' }
  const checkedAt = now.toISOString()
  // True once a download starts: it replaces the stored file, so a failure from then on leaves none.
  let replacing = false
  try {
    const result = await checkForAppUpdate(running, fetchImpl)
    if (result.state === 'newer' && result.apk) {
      // A file already downloaded and still good is kept; one that is gone (the cache was cleared,
      // so the plugin refuses the path) or no longer checks out is downloaded again.
      const have = prefs.ready
      if (have && have.version === result.latest && (await bridge.verify(have.path).then((v) => v.ok, () => false))) {
        patch({ lastCheckedAt: checkedAt, lastError: null })
        return { state: 'newer', latest: result.latest }
      }
      replacing = true
      const { path } = await bridge.download({ url: result.apk.url, name: result.apk.name, size: result.apk.size })
      const checked = await bridge.verify(path)
      if (checked.ok) {
        patch({ lastCheckedAt: checkedAt, lastError: null, ready: { version: result.latest, path, name: result.apk.name } })
        await quietly(() => bridge.notify({ version: result.latest }))
        return { state: 'newer', latest: result.latest }
      }
      await quietly(() => bridge.discard())
      await quietly(() => bridge.cancelNotification())
      const lastError = `The downloaded ${result.latest} file is not Polaris signed with this app's certificate, so it was not installed.`
      patch({ lastCheckedAt: checkedAt, ready: null, lastError })
      return { error: lastError }
    }
    if (prefs.ready) await quietly(() => bridge.discard())
    await quietly(() => bridge.cancelNotification())
    patch({ lastCheckedAt: checkedAt, ready: null, lastError: null })
    return { state: result.state, latest: result.latest }
  } catch (e) {
    const lastError = e?.message || 'The update check failed.'
    if (replacing) {
      await quietly(() => bridge.discard())
      await quietly(() => bridge.cancelNotification())
      patch({ lastCheckedAt: checkedAt, ready: null, lastError })
    } else {
      patch({ lastCheckedAt: checkedAt, lastError })
    }
    return { error: lastError }
  }
}

// Hands the ready APK to Android's installer. Until Android has allowed Polaris to install apps,
// opens the page where the owner allows it, once.
export async function installReadyUpdate({ bridge = defaultBridge } = {}) {
  const { ready } = readAppUpdatePrefs()
  if (!ready) throw new Error('No update is ready to install.')
  if (!(await bridge.canInstall())) {
    await bridge.openInstallSettings()
    return { opened: 'settings' }
  }
  await bridge.install(ready.path)
  return { opened: 'installer' }
}
