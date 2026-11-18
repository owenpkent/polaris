import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import AboutSettings, { formatBuild } from './AboutSettings'
import { markOffline, resetOfflineStatus } from './offlineStatus'
import { noteServerTime, resetServerClock } from './serverClock'

// A server that has not answered yet, so the first rows read the context's last health check.
const waiting = () => ({ health: () => new Promise(() => {}) })
const ORIGIN = 'http://server.test'
const fresh = () => ({ connected: true, local: false, baseUrl: ORIGIN, health: { version: '2.0.0' }, api: waiting() })
let connection = fresh()
vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))

beforeEach(() => {
  localStorage.clear()
  resetServerClock()
  resetOfflineStatus()
})

afterEach(() => {
  cleanup()
  resetOfflineStatus()
  connection = fresh()
})

const row = (label) => screen.getByText(label).nextElementSibling.textContent

// A reading that says the server is `offsetMs` ahead of this device, with a 100 ms round trip.
// Taken now by default: the card says so when a reading is more than two minutes old.
const T = Date.now()
const NOTICE = "This device's clock is not in step with the server's. Edits made offline on this device are still sent in the order you made them, with their times corrected. It is still worth setting the clock right."
const note = (offsetMs, at = T) => noteServerTime(ORIGIN, new Date(at + offsetMs + 50).toISOString(), at, at + 100)

describe('AboutSettings', () => {
  test('shows the dashboard build and the server version', () => {
    const builtAt = '2026-10-17T20:54:00.000Z'
    render(<AboutSettings build={{ version: '2.0.0', commit: 'cb8d766', builtAt }} />)
    expect(screen.getByRole('region', { name: 'About' })).toBeTruthy()
    expect(row('Dashboard')).toBe(`v2.0.0 · cb8d766 · built ${new Date(builtAt).toLocaleString()}`)
    expect(row('Server')).toBe('v2.0.0')
  })

  test('says when the server has not answered or there is no connection', () => {
    connection = { connected: true, health: null, api: waiting() }
    render(<AboutSettings />)
    expect(row('Server')).toBe('Not reached yet')
    cleanup()
    connection = { connected: false, health: null, api: waiting() }
    render(<AboutSettings />)
    expect(row('Server')).toBe('Not connected')
  })

  test('asks the server when it opens, so an updated server shows its new version', async () => {
    connection = { connected: true, health: { version: '2.0.0' }, api: { health: vi.fn().mockResolvedValue({ version: '2.1.0' }) } }
    render(<AboutSettings />)
    await waitFor(() => expect(row('Server')).toBe('v2.1.0'))
    expect(connection.api.health).toHaveBeenCalledTimes(1)
  })

  test('keeps the last reported version when the server cannot be reached', async () => {
    connection = { connected: true, health: { version: '2.0.0' }, api: { health: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } }
    render(<AboutSettings />)
    await waitFor(() => expect(connection.api.health).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(row('Server')).toBe('v2.0.0')
  })

  test('a switch to another server drops the last server\'s answer', async () => {
    connection = { connected: true, health: { version: '2.0.0' }, api: { health: vi.fn().mockResolvedValue({ version: '2.1.0' }) } }
    const { rerender } = render(<AboutSettings />)
    await waitFor(() => expect(row('Server')).toBe('v2.1.0'))
    connection = { connected: true, health: { version: '3.0.0' }, api: { health: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } }
    rerender(<AboutSettings />)
    await waitFor(() => expect(connection.api.health).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(row('Server')).toBe('v3.0.0')
  })

  test('a late answer from the last server is dropped after a switch', async () => {
    let answer
    connection = { connected: true, health: null, api: { health: vi.fn(() => new Promise((resolve) => { answer = resolve })) } }
    const { rerender } = render(<AboutSettings />)
    connection = { connected: true, health: { version: '3.0.0' }, api: waiting() }
    rerender(<AboutSettings />)
    answer({ version: '2.1.0' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(row('Server')).toBe('v3.0.0')
  })

  test('does not ask anything without a connection', () => {
    connection = { connected: false, health: null, api: { health: vi.fn() } }
    render(<AboutSettings />)
    expect(connection.api.health).not.toHaveBeenCalled()
    expect(row('Server')).toBe('Not connected')
  })

  describe('device clock', () => {
    test('says when no reading has been taken', () => {
      render(<AboutSettings />)
      expect(row('Device clock')).toBe('Not measured yet')
      expect(screen.queryByRole('status')).toBeNull()
    })

    test('says when the clocks match', () => {
      note(300)
      render(<AboutSettings />)
      expect(row('Device clock')).toBe("Matches the server's clock")
    })

    test('says how far behind the device is', () => {
      note(5000)
      render(<AboutSettings />)
      expect(row('Device clock')).toBe("5 seconds behind the server's clock")
    })

    test('says how far ahead the device is', () => {
      note(-2 * 60 * 1000)
      render(<AboutSettings />)
      expect(row('Device clock')).toBe("2 minutes ahead of the server's clock")
    })

    test('a reading for another server is not used', () => {
      noteServerTime('http://other.test', new Date(T + 5000).toISOString(), T, T + 100)
      render(<AboutSettings />)
      expect(row('Device clock')).toBe('Not measured yet')
    })

    test('shows nothing with no server at all', () => {
      note(10 * 60 * 1000)
      connection = { ...fresh(), local: true, connected: false }
      render(<AboutSettings />)
      expect(screen.queryByText('Device clock')).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
    })

    test('says it is the last reading when the server is out of reach', () => {
      note(5000)
      markOffline()
      render(<AboutSettings />)
      expect(row('Device clock')).toBe("5 seconds behind the server's clock, when last checked")
    })

    test('says so as well without a connection, but not for a missing reading', () => {
      note(0)
      connection = { ...fresh(), connected: false }
      render(<AboutSettings />)
      expect(row('Device clock')).toBe("Matches the server's clock, when last checked")
      cleanup()
      resetServerClock()
      render(<AboutSettings />)
      expect(row('Device clock')).toBe('Not measured yet')
    })

    test('a difference of ten minutes brings a notice, five seconds does not', () => {
      note(5000)
      render(<AboutSettings />)
      expect(screen.queryByRole('status')).toBeNull()
      cleanup()
      resetServerClock()
      note(10 * 60 * 1000)
      render(<AboutSettings />)
      expect(screen.getByRole('status').textContent).toBe(NOTICE)
    })

    test('the notice has the same words whatever the amount and the direction, so it is read out once', () => {
      note(-10 * 60 * 1000)
      render(<AboutSettings />)
      expect(row('Device clock')).toBe("10 minutes ahead of the server's clock")
      expect(screen.getByRole('status').textContent).toBe(NOTICE)
      act(() => { resetServerClock(); note(45 * 1000) })
      expect(row('Device clock')).toBe("45 seconds behind the server's clock")
      expect(screen.getByRole('status').textContent).toBe(NOTICE)
    })

    test('a reading more than two minutes old is given as the last one, connected or not', () => {
      note(5000, T - 5 * 60 * 1000)
      render(<AboutSettings />)
      expect(row('Device clock')).toBe("5 seconds behind the server's clock, when last checked")
    })

    test('follows a reading taken after it was shown', () => {
      render(<AboutSettings />)
      expect(row('Device clock')).toBe('Not measured yet')
      act(() => { note(10 * 60 * 1000) })
      expect(row('Device clock')).toBe("10 minutes behind the server's clock")
      expect(screen.getByRole('status')).toBeTruthy()
      act(() => { resetServerClock() })
      expect(row('Device clock')).toBe('Not measured yet')
      expect(screen.queryByRole('status')).toBeNull()
    })
  })

  test('a build without a commit or a version still reads', () => {
    expect(formatBuild({ version: '2.0.0', commit: null, builtAt: null })).toBe('v2.0.0')
    expect(formatBuild({ version: null, commit: null, builtAt: null })).toBe('Unknown')
  })

  test('the real build carries the package version', () => {
    expect(formatBuild()).toMatch(/^v\d+\.\d+\.\d+/)
  })
})
