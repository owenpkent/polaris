import { describe, test, expect, vi, afterEach } from 'vitest'
import {
  subscribeNativeShares, nativeCall, checkNotificationPermission, requestNotificationPermission,
  scheduleNotifications, cancelAllNotifications, subscribeNotificationTaps, subscribeAppResume, getAppInfo,
  downloadAppUpdate, verifyAppUpdate, canInstallApps, openInstallSettings, installAppUpdate, discardAppUpdate,
  scheduleAppUpdateNotification, cancelAppUpdateNotification, subscribeAppUpdateTaps, APP_UPDATE_NOTIFICATION_ID,
} from './nativeApp'

afterEach(() => {
  delete window.Capacitor
})

function fakeCapacitor() {
  const remove = vi.fn()
  let captured = null
  const addListener = vi.fn((plugin, event, cb) => {
    captured = cb
    return { remove }
  })
  window.Capacitor = { isNativePlatform: () => true, addListener }
  return { addListener, remove, fire: (url) => captured({ url }) }
}

describe('subscribeNativeShares', () => {
  test('does nothing outside the app', () => {
    expect(() => subscribeNativeShares(() => {})()).not.toThrow()
  })

  test('does nothing when the bridge has no addListener', () => {
    window.Capacitor = { isNativePlatform: () => true }
    expect(() => subscribeNativeShares(() => {})()).not.toThrow()
  })

  test('parses the opened url and hands over the share', () => {
    const cap = fakeCapacitor()
    const onShare = vi.fn()
    subscribeNativeShares(onShare)
    expect(cap.addListener).toHaveBeenCalledWith('App', 'appUrlOpen', expect.any(Function))
    cap.fire('polaris://share?share-text=Hello&share-url=https%3A%2F%2Fa.test')
    expect(onShare).toHaveBeenCalledWith({ title: '', text: 'Hello', url: 'https://a.test' })
  })

  test('ignores a url with no share and one that does not parse', () => {
    const cap = fakeCapacitor()
    const onShare = vi.fn()
    subscribeNativeShares(onShare)
    cap.fire('polaris://open?view=board')
    cap.fire('not a url')
    expect(onShare).not.toHaveBeenCalled()
  })

  test('unsubscribing removes the listener', () => {
    const cap = fakeCapacitor()
    subscribeNativeShares(() => {})()
    expect(cap.remove).toHaveBeenCalledTimes(1)
  })
})

describe('native calls', () => {
  function bridge(results = {}) {
    const nativePromise = vi.fn(async (plugin, method) => results[method] ?? {})
    const addListener = vi.fn(() => ({ remove: vi.fn() }))
    window.Capacitor = { isNativePlatform: () => true, nativePromise, addListener }
    return { nativePromise, addListener }
  }

  test('nativeCall rejects outside the app', async () => {
    await expect(nativeCall('LocalNotifications', 'getPending')).rejects.toThrow()
    window.Capacitor = { isNativePlatform: () => true }
    await expect(nativeCall('LocalNotifications', 'getPending')).rejects.toThrow()
  })

  test('getAppInfo returns version and build, null for what is missing', async () => {
    const cap = bridge({ getInfo: { version: '2.3.0', build: '20300' } })
    expect(await getAppInfo()).toEqual({ version: '2.3.0', build: '20300' })
    expect(cap.nativePromise).toHaveBeenCalledWith('App', 'getInfo', {})
    bridge({ getInfo: { version: '2.3.0' } })
    expect(await getAppInfo()).toEqual({ version: '2.3.0', build: null })
    delete window.Capacitor
    await expect(getAppInfo()).rejects.toThrow()
  })

  test('permission checks map display to a boolean', async () => {
    const cap = bridge({ checkPermissions: { display: 'prompt' }, requestPermissions: { display: 'granted' } })
    expect(await checkNotificationPermission()).toBe(false)
    expect(await requestNotificationPermission()).toBe(true)
    expect(cap.nativePromise).toHaveBeenCalledWith('LocalNotifications', 'requestPermissions', {})
  })

  test('scheduling cancels what is pending, then schedules with ISO times and the task id', async () => {
    const cap = bridge({ getPending: { notifications: [{ id: 5 }, { id: 6 }] } })
    const at = new Date(2026, 9, 6, 9, 0)
    await scheduleNotifications([{ id: 7, taskId: 't_abc123def4', title: 'Pay rent', body: 'Due today', at }])
    const calls = cap.nativePromise.mock.calls
    expect(calls[1]).toEqual(['LocalNotifications', 'cancel', { notifications: [{ id: 5 }, { id: 6 }] }])
    expect(calls[2]).toEqual(['LocalNotifications', 'schedule', { notifications: [{
      id: 7, title: 'Pay rent', body: 'Due today',
      schedule: { at: at.toISOString(), allowWhileIdle: true }, isExactNotification: false, extra: { taskId: 't_abc123def4' },
    }] }])
  })

  test('every reminder asks for an inexact alarm, so Android 12+ never sends the owner to settings', async () => {
    const cap = bridge()
    const at = new Date(2026, 9, 6, 9, 0)
    await scheduleNotifications([
      { id: 1, taskId: 't_aaaaaaaaaa', title: 'One', body: 'Due today', at },
      { id: 2, taskId: 't_bbbbbbbbbb', title: 'Two', body: 'Overdue', at },
    ])
    const schedule = cap.nativePromise.mock.calls.find((c) => c[1] === 'schedule')
    expect(schedule[2].notifications).toHaveLength(2)
    for (const n of schedule[2].notifications) expect(n.isExactNotification).toBe(false)
  })

  test('an empty plan only cancels', async () => {
    const cap = bridge({ getPending: { notifications: [{ id: 5 }] } })
    await scheduleNotifications([])
    expect(cap.nativePromise.mock.calls.map((c) => c[1])).toEqual(['getPending', 'cancel'])
  })

  test('cancelAllNotifications skips cancel when nothing is pending', async () => {
    const cap = bridge({ getPending: { notifications: [] } })
    await cancelAllNotifications()
    expect(cap.nativePromise.mock.calls.map((c) => c[1])).toEqual(['getPending'])
  })
})

describe('subscribeNotificationTaps and subscribeAppResume', () => {
  test('a tap hands over the task id, and unsubscribing removes the listener', () => {
    const cap = fakeCapacitor()
    const onTask = vi.fn()
    const off = subscribeNotificationTaps(onTask)
    expect(cap.addListener).toHaveBeenCalledWith('LocalNotifications', 'localNotificationActionPerformed', expect.any(Function))
    const handler = cap.addListener.mock.calls[0][2]
    handler({ notification: { extra: { taskId: 't_abc123def4' } } })
    handler({ notification: {} })
    expect(onTask).toHaveBeenCalledTimes(1)
    expect(onTask).toHaveBeenCalledWith('t_abc123def4')
    off()
    expect(cap.remove).toHaveBeenCalledTimes(1)
  })

  test('an update tap goes to the update subscriber and never to the reminder one', () => {
    const cap = fakeCapacitor()
    const onTask = vi.fn()
    const onUpdate = vi.fn()
    subscribeNotificationTaps(onTask)
    subscribeAppUpdateTaps(onUpdate)
    const [reminders, update] = cap.addListener.mock.calls.map((c) => c[2])
    const tap = { notification: { extra: { kind: 'app-update' } } }
    reminders(tap)
    update(tap)
    update({ notification: { extra: { taskId: 't_abc123def4' } } })
    expect(onTask).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledTimes(1)
    delete window.Capacitor
    expect(() => subscribeAppUpdateTaps(onUpdate)()).not.toThrow()
  })

  test('resume calls back, and both are no-ops outside the app', () => {
    const cap = fakeCapacitor()
    const cb = vi.fn()
    subscribeAppResume(cb)
    cap.addListener.mock.calls[0][2]()
    expect(cap.addListener.mock.calls[0].slice(0, 2)).toEqual(['App', 'resume'])
    expect(cb).toHaveBeenCalledTimes(1)
    delete window.Capacitor
    expect(() => subscribeAppResume(cb)()).not.toThrow()
    expect(() => subscribeNotificationTaps(cb)()).not.toThrow()
  })
})

describe('AppUpdater wrappers', () => {
  function bridge(results = {}) {
    const nativePromise = vi.fn(async (plugin, method) => results[method] ?? {})
    window.Capacitor = { isNativePlatform: () => true, nativePromise, addListener: vi.fn() }
    return nativePromise
  }

  test('each names the AppUpdater plugin and method', async () => {
    const np = bridge({
      download: { path: '/c/u/a.apk', size: 9 },
      verify: { ok: true, packageName: 'p', versionName: '2.4.0', versionCode: 20400, sameSigner: true },
      canInstall: { allowed: true },
    })
    expect(await downloadAppUpdate({ url: 'https://github.com/a', name: 'a.apk', size: 9 })).toEqual({ path: '/c/u/a.apk', size: 9 })
    expect(np).toHaveBeenLastCalledWith('AppUpdater', 'download', { url: 'https://github.com/a', name: 'a.apk', size: 9 })
    expect(await verifyAppUpdate('/c/u/a.apk')).toEqual({ ok: true, packageName: 'p', versionName: '2.4.0', versionCode: 20400, sameSigner: true })
    expect(np).toHaveBeenLastCalledWith('AppUpdater', 'verify', { path: '/c/u/a.apk' })
    expect(await canInstallApps()).toBe(true)
    expect(np).toHaveBeenLastCalledWith('AppUpdater', 'canInstall', {})
    await openInstallSettings()
    expect(np).toHaveBeenLastCalledWith('AppUpdater', 'openInstallSettings', {})
    await installAppUpdate('/c/u/a.apk')
    expect(np).toHaveBeenLastCalledWith('AppUpdater', 'install', { path: '/c/u/a.apk' })
    await discardAppUpdate()
    expect(np).toHaveBeenLastCalledWith('AppUpdater', 'discard', {})
  })

  test('a verify answer that is not ok stays not ok, and canInstall defaults to false', async () => {
    bridge({ verify: { ok: 'yes' }, canInstall: {} })
    expect((await verifyAppUpdate('/x')).ok).toBe(false)
    expect(await canInstallApps()).toBe(false)
  })

  test('the update notification has a fixed id no reminder can have, and the tap kind', async () => {
    const np = bridge()
    await scheduleAppUpdateNotification({ version: '2.4.0' })
    const [plugin, method, opts] = np.mock.calls[0]
    expect([plugin, method]).toEqual(['LocalNotifications', 'schedule'])
    expect(opts.notifications).toHaveLength(1)
    expect(opts.notifications[0]).toMatchObject({
      id: APP_UPDATE_NOTIFICATION_ID,
      title: 'Polaris 2.4.0 is ready to install',
      body: 'Tap to install. Android asks you to confirm once.',
      extra: { kind: 'app-update' },
    })
    expect(APP_UPDATE_NOTIFICATION_ID).toBeLessThan(0)
    await cancelAppUpdateNotification()
    expect(np).toHaveBeenLastCalledWith('LocalNotifications', 'cancel', { notifications: [{ id: APP_UPDATE_NOTIFICATION_ID }] })
  })

  test('cancelling the reminders leaves the update notification pending', async () => {
    const np = bridge({ getPending: { notifications: [{ id: 5 }, { id: APP_UPDATE_NOTIFICATION_ID }] } })
    await cancelAllNotifications()
    expect(np).toHaveBeenLastCalledWith('LocalNotifications', 'cancel', { notifications: [{ id: 5 }] })
  })
})
