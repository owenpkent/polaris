import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import ReminderScheduler from './ReminderScheduler'
import { saveReminderPrefs } from './reminders'

let native = true
const api = { listTasks: vi.fn() }
const scheduleNotifications = vi.fn()
const cancelAllNotifications = vi.fn()

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected: true, local: false, api }) }))
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
  api.listTasks.mockReset().mockResolvedValue({ tasks: [{ id: 't_abc123def4', title: 'Pay rent', dueAt: inTwoDays(), status: 'open' }] })
  scheduleNotifications.mockReset().mockResolvedValue(undefined)
  cancelAllNotifications.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

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
