import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import InboxTab from './InboxTab'
import { markOffline, resetOfflineStatus } from './offlineStatus'

let connected = true
const api = {}

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))

function item(over = {}) {
  return {
    id: 'i1',
    title: 'Fix the login bug',
    sourceType: 'github',
    sourceId: 'gh:42',
    notes: '',
    sourceUrl: 'https://github.com/x/y/issues/42',
    projectId: null,
    dueAt: null,
    priority: 'none',
    ...over,
  }
}

beforeEach(() => {
  connected = true
  window.matchMedia = vi.fn((query) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  Object.assign(api, {
    listInbox: vi.fn().mockResolvedValue({ tasks: [item()] }),
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    acceptInboxItem: vi.fn().mockResolvedValue({}),
    rejectInboxItem: vi.fn().mockResolvedValue({}),
  })
})

afterEach(() => {
  cleanup()
  delete window.matchMedia
  resetOfflineStatus()
})

describe('InboxTab', () => {
  test('lists a suggestion with its source', async () => {
    render(<InboxTab />)
    expect(await screen.findByText('Fix the login bug')).toBeTruthy()
    expect(screen.getByText('GitHub')).toBeTruthy()
  })

  test('shows the empty state once there is nothing left to review', async () => {
    api.listInbox.mockResolvedValue({ tasks: [] })
    render(<InboxTab />)
    expect(await screen.findByText('Inbox is empty.')).toBeTruthy()
  })

  test('Accept as task sends the default title and removes the suggestion', async () => {
    render(<InboxTab />)
    await screen.findByText('Fix the login bug')

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    const title = screen.getByRole('textbox', { name: 'Task name' })
    expect(title.value).toBe('Fix the login bug')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Accept as task' })) })

    expect(api.acceptInboxItem).toHaveBeenCalledWith('i1', {
      title: 'Fix the login bug', project: undefined, dueAt: undefined, priority: 'none',
    })
    await waitFor(() => expect(screen.getByText('Inbox is empty.')).toBeTruthy())
  })

  test('Confirm reject sends the typed reason and removes the suggestion', async () => {
    render(<InboxTab />)
    await screen.findByText('Fix the login bug')

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    fireEvent.change(screen.getByPlaceholderText('Why is this being rejected?'), { target: { value: 'Not needed' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' })) })

    expect(api.rejectInboxItem).toHaveBeenCalledWith('i1', { reason: 'Not needed' })
    await waitFor(() => expect(screen.getByText('Inbox is empty.')).toBeTruthy())
  })

  test('rejecting with no reason sends an empty payload', async () => {
    render(<InboxTab />)
    await screen.findByText('Fix the login bug')

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' })) })

    expect(api.rejectInboxItem).toHaveBeenCalledWith('i1', {})
  })

  test('Accept and Reject are disabled while the server is unreachable', async () => {
    render(<InboxTab />)
    await screen.findByText('Fix the login bug')
    act(() => markOffline())

    expect(screen.getByRole('button', { name: 'Accept' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Reject' }).disabled).toBe(true)
  })

  test('a load failure shows the error banner, and Retry loads again and clears it', async () => {
    api.listInbox.mockRejectedValueOnce(new Error('Could not reach the Command Center server.'))
    render(<InboxTab />)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('Could not reach the Command Center server.')
    expect(screen.queryByText('Fix the login bug')).toBeNull()

    // The second request answers, so the banner goes and the list is there.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api.listInbox).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Fix the login bug')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('not connected shows the connection form instead of loading the inbox', () => {
    connected = false
    render(<InboxTab />)
    expect(api.listInbox).not.toHaveBeenCalled()
    expect(screen.getByText('Connection settings')).toBeTruthy()
  })
})
