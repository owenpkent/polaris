import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import ReminderScheduler from './ReminderScheduler'
import { saveReminderPrefs } from './reminders'
import { createApiClient } from './api'
import { memoryBackend, setCacheBackend } from './offlineCache'
import { setOutboxBackend } from './outbox'

let native = true
const api = { listTasks: vi.fn() }
// What useConnection hands the scheduler. A test may swap in a real client from api.js.
let connection = { connected: true, local: false, api }
const scheduleNotifications = vi.fn()
const cancelAllNotifications = vi.fn()

vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))
vi.mock('./nativeApp', () => ({
  isNativeApp: () => native,
  scheduleNotifications: (...args) => scheduleNotifications(...args),
  cancelAllNotifications: (...args) => cancelAllNotifications(...args),
  subscribeAppResume: () => () => {},
}))

function inTwoDays() {
  const d = new Date(Date.now() + 48 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

beforeEach(() => {
  native = true
  connection = { connected: true, local: false, api }
  setCacheBackend(memoryBackend())
  setOutboxBackend(memoryBackend())
  api.listTasks.mockReset().mockResolvedValue({ tasks: [{ id: 't_abc123def4', title: 'Pay rent', dueAt: inTwoDays(), status: 'open' }] })
  scheduleNotifications.mockReset().mockResolvedValue(undefined)
  cancelAllNotifications.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete global.fetch
})

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function jsonResponse(data) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data) }
}

describe('ReminderScheduler', () => {
  test('enabled prefs schedule the plan', async () => {
    localStorage.setItem('cc-reminders-v1', JSON.stringify({ enabled: true, time: '09:00' }))
    render(<ReminderScheduler />)
    await waitFor(() => expect(scheduleNotifications).toHaveBeenCalled())
    const plan = scheduleNotifications.mock.calls[0][0]
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ taskId: 't_abc123def4', title: 'Pay rent', body: 'Due today' })
    expect(cancelAllNotifications).not.toHaveBeenCalled()
  })

  test('turning reminders off cancels them', async () => {
    localStorage.setItem('cc-reminders-v1', JSON.stringify({ enabled: true, time: '09:00' }))
    render(<ReminderScheduler />)
    await waitFor(() => expect(scheduleNotifications).toHaveBeenCalled())
    act(() => saveReminderPrefs({ enabled: false, time: '09:00' }))
    await waitFor(() => expect(cancelAllNotifications).toHaveBeenCalled())
  })

  test('prefs turned off while a sync is loading cancel, and the old pass never schedules', async () => {
    localStorage.setItem('cc-reminders-v1', JSON.stringify({ enabled: true, time: '09:00' }))
    const held = deferred()
    api.listTasks.mockReset().mockReturnValueOnce(held.promise)
    render(<ReminderScheduler />)
    await waitFor(() => expect(api.listTasks).toHaveBeenCalledTimes(1))
    act(() => saveReminderPrefs({ enabled: false, time: '09:00' }))
    await act(async () => {
      held.resolve({ tasks: [{ id: 't_abc123def4', title: 'Pay rent', dueAt: inTwoDays(), status: 'open' }] })
    })
    await waitFor(() => expect(cancelAllNotifications).toHaveBeenCalled())
    expect(scheduleNotifications).not.toHaveBeenCalled()
    expect(api.listTasks).toHaveBeenCalledTimes(1)
  })

  test('a task completed offline resyncs without a resume or a server event', async () => {
    localStorage.setItem('cc-reminders-v1', JSON.stringify({ enabled: true, time: '09:00' }))
    const task = { id: 't_abc123def4', title: 'Pay rent', dueAt: inTwoDays(), status: 'open', updatedAt: '2026-10-01T00:00:00.000Z' }
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ tasks: [task] }))
    const client = createApiClient('http://pc.test', 'tok')
    connection = { connected: true, local: false, api: client }
    render(<ReminderScheduler />)
    await waitFor(() => expect(scheduleNotifications).toHaveBeenCalledTimes(1))
    expect(scheduleNotifications.mock.calls[0][0]).toHaveLength(1)

    // The server goes away, and the task is completed from the local copy.
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await act(async () => { await client.completeTask(task.id) })
    await waitFor(() => expect(scheduleNotifications).toHaveBeenCalledTimes(2))
    expect(scheduleNotifications.mock.calls[1][0]).toEqual([])
  })

  test('a task made in local mode with a due date gets a reminder', async () => {
    localStorage.setItem('cc-reminders-v1', JSON.stringify({ enabled: true, time: '09:00' }))
    global.fetch = vi.fn().mockRejectedValue(new Error('local mode must not fetch'))
    const client = createApiClient('', '', { local: true })
    connection = { connected: false, local: true, api: client }
    render(<ReminderScheduler />)
    await waitFor(() => expect(scheduleNotifications).toHaveBeenCalledTimes(1))
    expect(scheduleNotifications.mock.calls[0][0]).toEqual([])

    await act(async () => { await client.createTask({ title: 'Call the bank', dueAt: inTwoDays() }) })
    await waitFor(() => expect(scheduleNotifications).toHaveBeenCalledTimes(2))
    expect(scheduleNotifications.mock.calls[1][0]).toEqual([expect.objectContaining({ title: 'Call the bank' })])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('does nothing outside the app', async () => {
    native = false
    localStorage.setItem('cc-reminders-v1', JSON.stringify({ enabled: true, time: '09:00' }))
    render(<ReminderScheduler />)
    await act(async () => {})
    expect(api.listTasks).not.toHaveBeenCalled()
    expect(scheduleNotifications).not.toHaveBeenCalled()
    expect(cancelAllNotifications).not.toHaveBeenCalled()
  })
})
