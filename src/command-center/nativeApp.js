import { parseShareParams } from './shareIntake'

// True inside the Android app (mobile/), where Capacitor injects window.Capacitor into the
// WebView. The dashboard has no dependency on Capacitor: this is the one place it looks for it.
export function isNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.())
  } catch {
    return false
  }
}

// Calls a method of a Capacitor plugin through the bridge. The page never loads Capacitor's
// JavaScript runtime, so there are no plugin objects to ask: the bridge's own nativePromise and
// addListener are the whole interface.
export function nativeCall(plugin, method, options = {}) {
  if (!isNativeApp() || typeof window.Capacitor?.nativePromise !== 'function') {
    return Promise.reject(new Error('Not running in the Android app.'))
  }
  return window.Capacitor.nativePromise(plugin, method, options)
}

// The installed app's version and build number, from Capacitor's App plugin. A missing field is null.
export async function getAppInfo() {
  const res = await nativeCall('App', 'getInfo')
  const text = (v) => (typeof v === 'string' && v ? v : null)
  return { version: text(res?.version), build: text(res?.build) }
}

export async function checkNotificationPermission() {
  const res = await nativeCall('LocalNotifications', 'checkPermissions')
  return res?.display === 'granted'
}

export async function requestNotificationPermission() {
  const res = await nativeCall('LocalNotifications', 'requestPermissions')
  return res?.display === 'granted'
}

// The "update ready" notification has one fixed id. Reminder ids (reminders.js notificationIdFor)
// are always positive, so a negative id can never be a reminder's.
export const APP_UPDATE_NOTIFICATION_ID = -7001

// Cancels every pending reminder. The update notification is not a reminder and is left alone.
export async function cancelAllNotifications() {
  const pending = await nativeCall('LocalNotifications', 'getPending')
  const notifications = (pending?.notifications || [])
    .filter(({ id }) => id !== APP_UPDATE_NOTIFICATION_ID)
    .map(({ id }) => ({ id }))
  if (notifications.length) await nativeCall('LocalNotifications', 'cancel', { notifications })
}

// Replaces every pending notification with the plan (reminders.js planReminders).
// Each one is an inexact alarm: the plugin defaults to exact, and on Android 12 and later an
// exact alarm without its special permission makes schedule() open the system settings instead,
// which every resume would then do again. A reminder a few minutes late is fine.
export async function scheduleNotifications(plan) {
  await cancelAllNotifications()
  if (!plan.length) return
  await nativeCall('LocalNotifications', 'schedule', {
    notifications: plan.map((item) => ({
      id: item.id,
      title: item.title,
      body: item.body,
      schedule: { at: item.at.toISOString(), allowWhileIdle: true },
      isExactNotification: false,
      extra: { taskId: item.taskId },
    })),
  })
}

// The Android shell's AppUpdater plugin (mobile/): downloads the release APK into the app's own
// cache, checks it is this app signed by the same certificate, and hands it to the system installer.
export async function downloadAppUpdate({ url, name, size }) {
  const res = await nativeCall('AppUpdater', 'download', { url, name, size })
  return { path: res?.path, size: res?.size }
}

export async function verifyAppUpdate(path) {
  const res = await nativeCall('AppUpdater', 'verify', { path })
  return {
    ok: res?.ok === true,
    packageName: res?.packageName ?? null,
    versionName: res?.versionName ?? null,
    versionCode: res?.versionCode ?? null,
    sameSigner: res?.sameSigner === true,
  }
}

export async function canInstallApps() {
  const res = await nativeCall('AppUpdater', 'canInstall')
  return res?.allowed === true
}

export async function openInstallSettings() {
  await nativeCall('AppUpdater', 'openInstallSettings')
}

export async function installAppUpdate(path) {
  await nativeCall('AppUpdater', 'install', { path })
}

export async function discardAppUpdate() {
  await nativeCall('AppUpdater', 'discard')
}

// One notification, shown at once, saying a checked APK is ready. Tapping it is handled by
// subscribeAppUpdateTaps.
export async function scheduleAppUpdateNotification({ version }) {
  await nativeCall('LocalNotifications', 'schedule', {
    notifications: [{
      id: APP_UPDATE_NOTIFICATION_ID,
      title: `Polaris ${version} is ready to install`,
      body: 'Tap to install. Android asks you to confirm once.',
      schedule: { at: new Date(Date.now() + 1000).toISOString(), allowWhileIdle: true },
      isExactNotification: false,
      extra: { kind: 'app-update' },
    }],
  })
}

export async function cancelAppUpdateNotification() {
  await nativeCall('LocalNotifications', 'cancel', { notifications: [{ id: APP_UPDATE_NOTIFICATION_ID }] })
}

function subscribeBridge(plugin, event, handler) {
  const noop = () => {}
  if (!isNativeApp()) return noop
  try {
    const cap = window.Capacitor
    if (typeof cap.addListener !== 'function') return noop
    const handle = cap.addListener(plugin, event, handler)
    return () => {
      try {
        handle?.remove?.()
      } catch {
        // Nothing to remove.
      }
    }
  } catch {
    return noop
  }
}

// Calls `onTaskId(id)` when the owner taps a reminder.
export function subscribeNotificationTaps(onTaskId) {
  return subscribeBridge('LocalNotifications', 'localNotificationActionPerformed', (event) => {
    const extra = event?.notification?.extra
    if (extra?.kind === 'app-update') return
    const id = extra?.taskId
    if (typeof id === 'string' && id) onTaskId(id)
  })
}

// Calls `cb()` when the owner taps the "update ready" notification.
export function subscribeAppUpdateTaps(cb) {
  return subscribeBridge('LocalNotifications', 'localNotificationActionPerformed', (event) => {
    if (event?.notification?.extra?.kind === 'app-update') cb()
  })
}

// Calls `cb` each time the app comes back to the foreground.
export function subscribeAppResume(cb) {
  return subscribeBridge('App', 'resume', () => cb())
}

// Calls `onShare(share)` for each share the Android shell delivers. The shell turns a share intent
// into an appUrlOpen event whose URL carries the share-title, share-text and share-url parameters
// (shareIntake.js). Returns an unsubscribe; outside the app it does nothing and returns a no-op.
export function subscribeNativeShares(onShare) {
  const noop = () => {}
  if (!isNativeApp()) return noop
  try {
    const cap = window.Capacitor
    if (typeof cap.addListener !== 'function') return noop
    const handle = cap.addListener('App', 'appUrlOpen', ({ url } = {}) => {
      try {
        const share = parseShareParams(new URL(url).search)
        if (share) onShare(share)
      } catch {
        // A URL that does not parse is not a share.
      }
    })
    return () => {
      try {
        handle?.remove?.()
      } catch {
        // Nothing to remove.
      }
    }
  } catch {
    return noop
  }
}
