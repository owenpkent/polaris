import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, act, fireEvent } from '@testing-library/react'
import { resetOfflineStatus, setPending } from './offlineStatus'

const disconnect = vi.fn()
vi.mock('./ConnectionContext', () => ({
  useConnection: () => ({
    baseUrl: 'http://x', token: 'tok', connected: true, health: null, testing: false, testResult: null,
    saveSettings: vi.fn(), disconnect,
  }),
}))

const { default: SettingsForm } = await import('./SettingsForm')

beforeEach(() => {
  disconnect.mockClear()
  resetOfflineStatus()
})

afterEach(() => cleanup())

describe('Disconnect with offline edits waiting', () => {
  test('with nothing waiting, Disconnect acts on the first click', () => {
    render(<SettingsForm />)
    expect(screen.queryByRole('note')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  test('with edits waiting, it says what would be lost and asks before discarding them', () => {
    render(<SettingsForm />)
    act(() => setPending(2))
    expect(screen.getByRole('note').textContent).toContain('2 offline changes have not reached the server yet')

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(disconnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(disconnect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard 2 unsent changes?' }))
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  test('one waiting edit is worded in the singular', () => {
    render(<SettingsForm />)
    act(() => setPending(1))
    expect(screen.getByRole('note').textContent).toContain('1 offline change has not reached the server yet')
  })
})
