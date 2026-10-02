import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import JobWarningsBanner from './JobWarningsBanner'
import { markOffline, resetOfflineStatus } from './command-center/offlineStatus'

const connection = { connected: true, api: { getSync: vi.fn() } }
vi.mock('./command-center/ConnectionContext', () => ({ useConnection: () => connection }))
vi.mock('./OfflineBanner', () => ({ Strip: ({ children }) => <div role="status">{children}</div> }))

afterEach(() => {
  cleanup()
  resetOfflineStatus()
  connection.connected = true
  connection.api.getSync.mockReset()
})

describe('JobWarningsBanner', () => {
  test('shows every warning the server sends', async () => {
    connection.api.getSync.mockResolvedValue({ jobs: {}, warnings: [
      { job: 'backup', message: 'The last database backup is 3 day(s) old.' },
      { job: 'github', message: 'The github job is failing: rate limited' },
    ] })
    render(<JobWarningsBanner />)
    const strip = await screen.findByRole('status')
    expect(strip.textContent).toContain('The last database backup is 3 day(s) old.')
    expect(strip.textContent).toContain('The github job is failing: rate limited')
  })

  test('shows nothing when there are no warnings, or when an older server sends none', async () => {
    connection.api.getSync.mockResolvedValue({ jobs: {} })
    render(<JobWarningsBanner />)
    await waitFor(() => expect(connection.api.getSync).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  test('stays hidden and does not ask while offline, since the answer would be a saved copy', () => {
    markOffline()
    render(<JobWarningsBanner />)
    expect(connection.api.getSync).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  test('a failed request leaves the banner hidden', async () => {
    connection.api.getSync.mockRejectedValue(new Error('boom'))
    render(<JobWarningsBanner />)
    await waitFor(() => expect(connection.api.getSync).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })
})
