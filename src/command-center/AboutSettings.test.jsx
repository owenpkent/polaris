import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import AboutSettings, { formatBuild } from './AboutSettings'

// A server that has not answered yet, so the first rows read the context's last health check.
const waiting = () => ({ health: () => new Promise(() => {}) })
let connection = { connected: true, health: { version: '2.0.0' }, api: waiting() }
vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))

afterEach(() => {
  cleanup()
  connection = { connected: true, health: { version: '2.0.0' }, api: waiting() }
})

const row = (label) => screen.getByText(label).nextElementSibling.textContent

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

  test('a build without a commit or a version still reads', () => {
    expect(formatBuild({ version: '2.0.0', commit: null, builtAt: null })).toBe('v2.0.0')
    expect(formatBuild({ version: null, commit: null, builtAt: null })).toBe('Unknown')
  })

  test('the real build carries the package version', () => {
    expect(formatBuild()).toMatch(/^v\d+\.\d+\.\d+/)
  })
})
