import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ThreadsTab, { daysSince } from './ThreadsTab'

const api = {}
let connected = true

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))
vi.mock('./TaskDetailPanel', () => ({
  default: ({ taskId, onClose }) => (
    <div role="dialog" aria-label="Task details">
      Panel for {taskId}
      <button type="button" onClick={onClose}>Close</button>
    </div>
  ),
}))

const DAY = 24 * 60 * 60 * 1000

function row(over = {}) {
  return {
    thread: { id: 'th_1', taskId: 't_1', title: 'The bound', status: 'open', pinnedPostId: null, authorHidden: false, dailyCap: null, successorThreadId: null, createdAt: '2026-10-01T00:00:00.000Z', closedAt: null },
    taskTitle: 'Prove the bound',
    postCount: 4, openClaims: 2, objections: 1, unansweredObjections: 1, results: 1, acceptedResults: 1,
    lastProgressAt: new Date(Date.now() - 3 * DAY).toISOString(),
    ...over,
  }
}

beforeEach(() => {
  connected = true
  Object.assign(api, { getThreads: vi.fn().mockResolvedValue({ threads: [] }) })
})

afterEach(() => cleanup())

describe('daysSince', () => {
  test('counts whole days and never goes negative', () => {
    const now = Date.parse('2026-10-05T12:00:00.000Z')
    expect(daysSince('2026-10-05T11:00:00.000Z', now)).toBe(0)
    expect(daysSince('2026-10-02T12:00:00.000Z', now)).toBe(3)
    expect(daysSince('2026-10-06T12:00:00.000Z', now)).toBe(0)
    expect(daysSince(null, now)).toBe(null)
    expect(daysSince('nonsense', now)).toBe(null)
  })
})

describe('ThreadsTab', () => {
  test('asks for a connection instead of loading when there is none', () => {
    connected = false
    render(<ThreadsTab />)
    expect(api.getThreads).not.toHaveBeenCalled()
  })

  test('shows the thread title only when it differs from the task title', async () => {
    api.getThreads.mockResolvedValue({ threads: [row({ thread: { ...row().thread, title: 'Prove the bound' } })] })
    render(<ThreadsTab />)
    const card = await screen.findByRole('article', { name: 'Prove the bound' })
    expect(within(card).getAllByText(/Prove the bound/)).toHaveLength(1)
    expect(within(card).getByRole('button', { name: 'Open Prove the bound' })).toBeTruthy()
  })

  test('lists open threads with their four figures and a button to the task', async () => {
    api.getThreads.mockResolvedValue({ threads: [row()] })
    render(<ThreadsTab />)

    const card = await screen.findByRole('article', { name: 'The bound' })
    expect(api.getThreads).toHaveBeenCalledWith('open')
    expect(within(card).getByText('Open claims').previousSibling.textContent).toBe('2')
    expect(within(card).getByText('Unanswered objections').previousSibling.textContent).toBe('1')
    expect(within(card).getByText('Accepted results').previousSibling.textContent).toBe('1')
    expect(within(card).getByText('Days since progress').previousSibling.textContent).toBe('3')

    fireEvent.click(within(card).getByRole('button', { name: 'Open Prove the bound' }))
    expect(screen.getByRole('dialog', { name: 'Task details' }).textContent).toContain('Panel for t_1')
  })

  test('Closed threads asks for the closed ones and reads as pressed', async () => {
    api.getThreads.mockResolvedValue({ threads: [] })
    render(<ThreadsTab />)

    expect(await screen.findByText('No open threads')).toBeTruthy()
    const open = screen.getByRole('button', { name: 'Open threads' })
    const closed = screen.getByRole('button', { name: 'Closed threads' })
    expect(open.getAttribute('aria-pressed')).toBe('true')
    api.getThreads.mockResolvedValue({ threads: [row({ thread: { ...row().thread, status: 'closed' } })] })
    fireEvent.click(closed)
    await waitFor(() => expect(api.getThreads).toHaveBeenLastCalledWith('closed'))
    expect(closed.getAttribute('aria-pressed')).toBe('true')
    expect(open.getAttribute('aria-pressed')).toBe('false')
    expect(await screen.findByRole('article', { name: 'The bound' })).toBeTruthy()
  })

  test('a slow answer for the other toggle never lands under the current one', async () => {
    let resolveOpen
    api.getThreads.mockImplementation((status) => {
      if (status === 'open') return new Promise((resolve) => { resolveOpen = resolve })
      return Promise.resolve({ threads: [row({ thread: { ...row().thread, status: 'closed', title: 'Closed one' } })] })
    })
    render(<ThreadsTab />)
    await waitFor(() => expect(api.getThreads).toHaveBeenCalledWith('open'))

    fireEvent.click(screen.getByRole('button', { name: 'Closed threads' }))
    expect(await screen.findByRole('article', { name: 'Closed one' })).toBeTruthy()
    // The first request answers last, with open threads.
    resolveOpen({ threads: [row({ thread: { ...row().thread, title: 'Stale open one' } })] })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole('article', { name: 'Stale open one' })).toBeNull()
    expect(screen.getByRole('article', { name: 'Closed one' })).toBeTruthy()
  })

  test('the empty state says where a thread starts', async () => {
    render(<ThreadsTab />)
    expect(await screen.findByText('No open threads')).toBeTruthy()
    expect(screen.getByText("A thread starts from a task's panel, under Thread.")).toBeTruthy()
  })

  test('a failed answer shows the banner and Retry loads the list', async () => {
    api.getThreads.mockRejectedValueOnce(new Error('Request failed (500)'))
    render(<ThreadsTab />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Request failed (500)')
    api.getThreads.mockResolvedValue({ threads: [row()] })
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('article', { name: 'The bound' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
