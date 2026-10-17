import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import AboutSettings, { formatBuild } from './AboutSettings'

let connection = { connected: true, health: { version: '2.0.0' } }
vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))

afterEach(() => {
  cleanup()
  connection = { connected: true, health: { version: '2.0.0' } }
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
    connection = { connected: true, health: null }
    render(<AboutSettings />)
    expect(row('Server')).toBe('Not reached yet')
    cleanup()
    connection = { connected: false, health: null }
    render(<AboutSettings />)
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
