import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ThreadSection from './ThreadSection'
import { markOffline, resetOfflineStatus } from './offlineStatus'

const api = {
  getThread: vi.fn(),
  createThread: vi.fn(),
  addPost: vi.fn(),
}
vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected: true, api }) }))

const TASK = { id: 't_1', title: 'Hard problem', status: 'open', untrustedText: false }
const THREAD = { id: 'th_1', taskId: 't_1', title: 'Hard problem', status: 'open', pinnedPostId: null, createdAt: '2026-10-05T10:00:00.000Z', closedAt: null }

function post(id, type, body, extra = {}) {
  return {
    id, threadId: 'th_1', parentPostId: null, author: 'agent', authorName: 'scribe', type, body,
    confidence: null, status: type === 'claim' ? 'open' : null, refs: [], untrustedText: false,
    createdAt: '2026-10-05T10:05:00.000Z', ...extra,
  }
}

const POSTS = [
  post('p_1', 'claim', 'The bound is 4680.', { confidence: 'medium' }),
  post('p_2', 'objection', 'The lemma on page 3 assumes smoothness.'),
  post('p_3', 'evidence', 'Test run output attached.', { author: 'human', authorName: null, untrustedText: true }),
]

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  resetOfflineStatus()
})

afterEach(() => {
  cleanup()
  resetOfflineStatus()
})

describe('without a thread', () => {
  test('explains and offers Start a thread, which creates one and reloads', async () => {
    api.getThread.mockResolvedValueOnce(null)
    api.createThread.mockResolvedValue({ thread: THREAD })
    api.getThread.mockResolvedValue({ thread: THREAD, posts: [] })
    render(<ThreadSection task={TASK} />)

    expect(await screen.findByText(/No thread yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start a thread' }))

    await waitFor(() => expect(api.createThread).toHaveBeenCalledWith('t_1'))
    expect(await screen.findByText('No posts yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start a thread' })).toBeNull()
  })

  test('is read-only on a task holding third-party text', async () => {
    api.getThread.mockResolvedValue(null)
    render(<ThreadSection task={{ ...TASK, untrustedText: true }} />)

    expect(await screen.findByText(/Posting is off here/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start a thread' })).toBeNull()
  })

  test('renders nothing for an inbox task', () => {
    api.getThread.mockResolvedValue(null)
    const { container } = render(<ThreadSection task={{ ...TASK, status: 'inbox' }} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('with posts', () => {
  test('shows each post with its type chip, author, and untrusted badge', async () => {
    api.getThread.mockResolvedValue({ thread: THREAD, posts: POSTS })
    render(<ThreadSection task={TASK} />)

    const list = await screen.findByRole('list', { name: 'Posts' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(within(items[0]).getByText('Claim')).toBeTruthy()
    expect(within(items[0]).getByText(/scribe/)).toBeTruthy()
    expect(within(items[0]).getByText(/Medium confidence/)).toBeTruthy()
    expect(within(items[1]).getByText('Objection')).toBeTruthy()
    expect(within(items[2]).getByText('Evidence')).toBeTruthy()
    expect(within(items[2]).getByText(/You/)).toBeTruthy()
    expect(within(items[2]).getByText('Untrusted text')).toBeTruthy()
  })

  test('Objections only filters the list and reads as pressed', async () => {
    api.getThread.mockResolvedValue({ thread: THREAD, posts: POSTS })
    render(<ThreadSection task={TASK} />)

    const toggle = await screen.findByRole('button', { name: 'Objections only (1)' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const items = within(screen.getByRole('list', { name: 'Posts' })).getAllByRole('listitem')
    expect(items).toHaveLength(1)
    expect(within(items[0]).getByText('The lemma on page 3 assumes smoothness.')).toBeTruthy()
    fireEvent.click(toggle)
    expect(within(screen.getByRole('list', { name: 'Posts' })).getAllByRole('listitem')).toHaveLength(3)
  })

  test('posting sends the type and body, clears the draft, and reloads', async () => {
    api.getThread.mockResolvedValueOnce({ thread: THREAD, posts: POSTS })
    api.addPost.mockResolvedValue({ post: post('p_4', 'question', 'Which norm?') })
    api.getThread.mockResolvedValue({ thread: THREAD, posts: [...POSTS, post('p_4', 'question', 'Which norm?', { author: 'human', authorName: null })] })
    render(<ThreadSection task={TASK} />)

    await screen.findByRole('list', { name: 'Posts' })
    const postButton = screen.getByRole('button', { name: 'Post' })
    expect(postButton.disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Post type' }), { target: { value: 'question' } })
    const body = screen.getByRole('textbox', { name: 'New post' })
    fireEvent.change(body, { target: { value: 'Which norm?' } })
    expect(postButton.disabled).toBe(false)
    fireEvent.click(postButton)

    await waitFor(() => expect(api.addPost).toHaveBeenCalledWith('th_1', { type: 'question', body: 'Which norm?' }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Posts' })).getAllByRole('listitem')).toHaveLength(4))
    expect(screen.getByRole('textbox', { name: 'New post' }).value).toBe('')
    expect(api.getThread).toHaveBeenCalledTimes(2)
  })

  test('reloads when the panel bumps refreshKey', async () => {
    api.getThread.mockResolvedValue({ thread: THREAD, posts: POSTS })
    const { rerender } = render(<ThreadSection task={TASK} refreshKey={1} />)
    await screen.findByRole('list', { name: 'Posts' })
    rerender(<ThreadSection task={TASK} refreshKey={2} />)
    await waitFor(() => expect(api.getThread).toHaveBeenCalledTimes(2))
  })

  test('a failed post shows the error and keeps the draft', async () => {
    api.getThread.mockResolvedValue({ thread: THREAD, posts: POSTS })
    api.addPost.mockRejectedValue(new Error('Request failed (500)'))
    render(<ThreadSection task={TASK} />)

    await screen.findByRole('list', { name: 'Posts' })
    fireEvent.change(screen.getByRole('textbox', { name: 'New post' }), { target: { value: 'Still here' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'New post' }).value).toBe('Still here')
  })
})

describe('offline', () => {
  test('a task with no thread shows one muted line and no alert when the server cannot be reached', async () => {
    api.getThread.mockRejectedValue(Object.assign(new Error('Could not reach the Command Center server.'), { code: 'network_error', status: 0 }))
    markOffline()
    render(<ThreadSection task={TASK} />)

    expect(await screen.findByText('Thread unavailable offline.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start a thread' })).toBeNull()
    expect(screen.queryByText(/No thread yet/)).toBeNull()
  })

  test('a thread loaded before the server went away stays on screen', async () => {
    api.getThread.mockResolvedValueOnce({ thread: THREAD, posts: POSTS })
    const { rerender } = render(<ThreadSection task={TASK} refreshKey={0} />)
    await screen.findByRole('list', { name: 'Posts' })

    api.getThread.mockRejectedValue(Object.assign(new Error('Could not reach the Command Center server.'), { code: 'network_error', status: 0 }))
    markOffline()
    rerender(<ThreadSection task={TASK} refreshKey={1} />)

    await waitFor(() => expect(api.getThread).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('list', { name: 'Posts' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('a real server error still shows the alert', async () => {
    api.getThread.mockRejectedValue(Object.assign(new Error('Internal error'), { code: 'internal_error', status: 500 }))
    render(<ThreadSection task={TASK} />)

    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  test('Start a thread is off with a hint', async () => {
    api.getThread.mockResolvedValue(null)
    markOffline()
    render(<ThreadSection task={TASK} />)

    const start = await screen.findByRole('button', { name: 'Start a thread' })
    expect(start.disabled).toBe(true)
    expect(screen.getByText('Offline. Posting needs the server.')).toBeTruthy()
  })

  test('Post is off with a hint even with a draft typed', async () => {
    api.getThread.mockResolvedValue({ thread: THREAD, posts: POSTS })
    markOffline()
    render(<ThreadSection task={TASK} />)

    await screen.findByRole('list', { name: 'Posts' })
    fireEvent.change(screen.getByRole('textbox', { name: 'New post' }), { target: { value: 'Typed offline' } })
    expect(screen.getByRole('button', { name: 'Post' }).disabled).toBe(true)
    expect(screen.getByText('Offline. Posting needs the server.')).toBeTruthy()
  })
})
