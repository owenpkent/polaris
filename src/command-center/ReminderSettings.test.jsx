import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ReminderSettings from './ReminderSettings'
import { loadReminderPrefs } from './reminders'

let native = true
const requestNotificationPermission = vi.fn()
vi.mock('./nativeApp', () => ({
  isNativeApp: () => native,
  requestNotificationPermission: (...args) => requestNotificationPermission(...args),
}))

const LABEL = 'Remind me on the day a task is due'

beforeEach(() => {
  native = true
  requestNotificationPermission.mockReset()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ReminderSettings', () => {
  test('renders nothing outside the app', () => {
    native = false
    const { container } = render(<ReminderSettings />)
    expect(container.innerHTML).toBe('')
  })

  test('enabling with permission granted saves, and the time field unlocks', async () => {
    requestNotificationPermission.mockResolvedValue(true)
    render(<ReminderSettings />)
    expect(screen.getByRole('region', { name: 'Reminders' })).toBeTruthy()
    expect(screen.getByLabelText('Time').disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: LABEL }))
    await waitFor(() => expect(loadReminderPrefs().enabled).toBe(true))
    expect(screen.getByLabelText('Time').disabled).toBe(false)
  })

  test('permission denied keeps it off and says why', async () => {
    requestNotificationPermission.mockResolvedValue(false)
    render(<ReminderSettings />)
    fireEvent.click(screen.getByRole('checkbox', { name: LABEL }))
    expect(await screen.findByText('Notifications are turned off for Polaris in Android settings.')).toBeTruthy()
    expect(loadReminderPrefs().enabled).toBe(false)
    expect(screen.getByRole('checkbox', { name: LABEL }).checked).toBe(false)
  })

  test('changing the time saves it, and switching off saves that', () => {
    localStorage.setItem('cc-reminders-v1', JSON.stringify({ enabled: true, time: '09:00' }))
    render(<ReminderSettings />)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '18:30' } })
    expect(loadReminderPrefs()).toEqual({ enabled: true, time: '18:30' })
    fireEvent.click(screen.getByRole('checkbox', { name: LABEL }))
    expect(loadReminderPrefs()).toEqual({ enabled: false, time: '18:30' })
  })
})
