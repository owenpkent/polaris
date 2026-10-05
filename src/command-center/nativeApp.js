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

export async function checkNotificationPermission() {
  const res = await nativeCall('LocalNotifications', 'checkPermissions')
  return res?.display === 'granted'
}

export async function requestNotificationPermission() {
  const res = await nativeCall('LocalNotifications', 'requestPermissions')
  return res?.display === 'granted'
}

export async function cancelAllNotifications() {
  const pending = await nativeCall('LocalNotifications', 'getPending')
  const notifications = (pending?.notifications || []).map(({ id }) => ({ id }))
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
    const id = event?.notification?.extra?.taskId
    if (typeof id === 'string' && id) onTaskId(id)
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
