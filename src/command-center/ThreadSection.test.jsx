import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ThreadSection from './ThreadSection'
import { markOffline, resetOfflineStatus } from './offlineStatus'

const api = {
  getThread: vi.fn(),
  createThread: vi.fn(),
  addPost: vi.fn(),
  getThreadPosts: vi.fn(),
  patchThread: vi.fn(),
  closeThread: vi.fn(),
  reopenThread: vi.fn(),
  forkThread: vi.fn(),
  setPostStatus: vi.fn(),
}
vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected: true, api }) }))

const TASK = { id: 't_1', title: 'Hard problem', status: 'open', untrustedText: false }
const THREAD = {
  id: 'th_1', taskId: 't_1', title: 'Hard problem', status: 'open', pinnedPostId: null, authorHidden: false, dailyCap: null,
  successorThreadId: null, createdAt: '2026-10-05T10:00:00.000Z', closedAt: null,
}

function post(id, type, body, extra = {}) {
  return {
    id, threadId: 'th_1', parentPostId: null, author: 'agent', authorName: 'scribe', type, body,
    confidence: null, status: type === 'claim' || type === 'result' ? 'open' : null, refs: [], untrustedText: false,
    judgedAt: null, createdAt: '2026-10-05T10:05:00.000Z', ...extra,
  }
}

const POSTS = [
  post('p_1', 'claim', 'The bound is 4680.', { confidence: 'medium' }),
  post('p_2', 'objection', 'The lemma on page 3 assumes smoothness.'),
  post('p_3', 'evidence', 'Test run output attached.', { author: 'human', authorName: null, untrustedText: true }),
]

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getThreadPosts.mockResolvedValue({ thread: { ...THREAD, id: 'th_2', taskId: 't_2' }, posts: [] })
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

  test('says how many earlier posts the window left out', async () => {
    api.getThread.mockResolvedValue({ thread: THREAD, posts: POSTS, total: 503 })
    render(<ThreadSection task={TASK} />)

    await screen.findByRole('list', { name: 'Posts' })
    expect(screen.getByText('500 earlier posts are not shown.')).toBeTruthy()
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

describe("the owner's judgement", () => {
  const SUMMARY = post('p_5', 'summary', 'Where we are: the bound holds in the smooth case.')

  test('a claim shows its status and Accept calls setPostStatus and reloads', async () => {
    api.getThread.mockResolvedValueOnce({ thread: THREAD, posts: POSTS })
    api.setPostStatus.mockResolvedValue({ post: { ...POSTS[0], status: 'accepted' } })
    api.getThread.mockResolvedValue({ thread: THREAD, posts: [{ ...POSTS[0], status: 'accepted' }, ...POSTS.slice(1)] })
    render(<ThreadSection task={TASK} />)

    const list = await screen.findByRole('list', { name: 'Posts' })
    const claim = within(list).getAllByRole('listitem')[0]
    expect(within(claim).getByText('Open')).toBeTruthy()
    fireEvent.click(within(claim).getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(api.setPostStatus).toHaveBeenCalledWith('p_1', 'accepted'))
    await waitFor(() => expect(api.getThread).toHaveBeenCalledTimes(2))
    const judged = within(screen.getByRole('list', { name: 'Posts' })).getAllByRole('listitem')[0]
    expect(within(judged).getByText('Accepted')).toBeTruthy()
    expect(within(judged).queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(within(judged).getByRole('button', { name: 'Mark open' })).toBeTruthy()
    // An objection carries no verdict.
    const objection = within(screen.getByRole('list', { name: 'Posts' })).getAllByRole('listitem')[1]
    expect(within(objection).queryByRole('button', { name: 'Accept' })).toBeNull()
  })

  test('a pinned post older than the loaded window still shows, from the payload', async () => {
    api.getThread.mockResolvedValue({ thread: { ...THREAD, pinnedPostId: 'p_5' }, posts: POSTS, total: 600, pinned: SUMMARY })
    render(<ThreadSection task={TASK} />)

    const block = await screen.findByRole('region', { name: 'Pinned state' })
    expect(within(block).getByText(SUMMARY.body)).toBeTruthy()
    expect(screen.getByText('597 earlier posts are not shown.')).toBeTruthy()
  })

  test('Pin sends the post id, and the pinned state block shows it with Unpin', async () => {
    api.getThread.mockResolvedValueOnce({ thread: THREAD, posts: [...POSTS, SUMMARY] })
    api.patchThread.mockResolvedValue({ thread: { ...THREAD, pinnedPostId: 'p_5' } })
    api.getThread.mockResolvedValue({ thread: { ...THREAD, pinnedPostId: 'p_5' }, posts: [...POSTS, SUMMARY] })
    render(<ThreadSection task={TASK} />)

    const list = await screen.findByRole('list', { name: 'Posts' })
    expect(screen.queryByRole('region', { name: 'Pinned state' })).toBeNull()
    fireEvent.click(within(within(list).getAllByRole('listitem')[3]).getByRole('button', { name: 'Pin' }))

    await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith('th_1', { pinnedPostId: 'p_5' }))
    const pinned = await screen.findByRole('region', { name: 'Pinned state' })
    expect(within(pinned).getByText(SUMMARY.body)).toBeTruthy()
    expect(within(pinned).getByText('Pinned')).toBeTruthy()

    api.patchThread.mockClear()
    fireEvent.click(within(pinned).getByRole('button', { name: 'Unpin' }))
    await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith('th_1', { pinnedPostId: null }))
  })

  test('Close thread hides the form and the controls, and Reopen thread brings them back', async () => {
    api.getThread.mockResolvedValueOnce({ thread: THREAD, posts: POSTS })
    const closed = { ...THREAD, status: 'closed', closedAt: '2026-10-05T12:00:00.000Z' }
    api.closeThread.mockResolvedValue({ thread: closed })
    api.getThread.mockResolvedValueOnce({ thread: closed, posts: POSTS })
    render(<ThreadSection task={TASK} />)

    await screen.findByRole('list', { name: 'Posts' })
    fireEvent.click(screen.getByRole('button', { name: 'Close thread' }))

    await waitFor(() => expect(api.closeThread).toHaveBeenCalledWith('th_1'))
    expect(await screen.findByText(/^Closed/)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'New post' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Thread settings' })).toBeNull()

    api.reopenThread.mockResolvedValue({ thread: THREAD })
    api.getThread.mockResolvedValue({ thread: THREAD, posts: POSTS })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen thread' }))
    await waitFor(() => expect(api.reopenThread).toHaveBeenCalledWith('th_1'))
    expect(await screen.findByRole('textbox', { name: 'New post' })).toBeTruthy()
  })

  test('Fork opens a titled form, Esc cancels it without bubbling, and Fork thread sends the title', async () => {
    api.getThread.mockResolvedValue({ thread: THREAD, posts: POSTS })
    api.forkThread.mockResolvedValue({ thread: { ...THREAD, status: 'closed', successorThreadId: 'th_2' }, successor: { ...THREAD, id: 'th_2', taskId: 't_2' }, task: { id: 't_2' } })
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    render(<ThreadSection task={TASK} />)

    await screen.findByRole('list', { name: 'Posts' })
    const fork = screen.getByRole('button', { name: 'Fork' })
    expect(fork.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(fork)
    const title = screen.getByRole('textbox', { name: 'Title of the new thread' })
    expect(screen.getByRole('button', { name: 'Fork thread' }).disabled).toBe(true)

    fireEvent.keyDown(title, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Title of the new thread' })).toBeNull()
    expect(onWindowKey).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(fork)

    fireEvent.click(fork)
    fireEvent.change(screen.getByRole('textbox', { name: 'Title of the new thread' }), { target: { value: 'The unforced case' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fork thread' }))
    await waitFor(() => expect(api.forkThread).toHaveBeenCalledWith('th_1', 'The unforced case'))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Title of the new thread' })).toBeNull())
    window.removeEventListener('keydown', onWindowKey)
  })

  test('the Hide authors switch reads its state and patches the thread', async () => {
    api.getThread.mockResolvedValueOnce({ thread: THREAD, posts: POSTS })
    api.patchThread.mockResolvedValue({ thread: { ...THREAD, authorHidden: true } })
    api.getThread.mockResolvedValue({ thread: { ...THREAD, authorHidden: true }, posts: POSTS })
    render(<ThreadSection task={TASK} />)

    const toggle = await screen.findByRole('switch', { name: 'Hide authors from agents' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith('th_1', { authorHidden: true }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Hide authors from agents' }).getAttribute('aria-checked')).toBe('true'))
  })

  test('the daily cap saves on blur and on Enter, and an empty field means none', async () => {
    api.getThread.mockResolvedValue({ thread: { ...THREAD, dailyCap: 5 }, posts: POSTS })
    api.patchThread.mockResolvedValue({ thread: { ...THREAD, dailyCap: 20 } })
    render(<ThreadSection task={TASK} />)

    const cap = await screen.findByRole('spinbutton', { name: 'Daily cap per agent' })
    expect(cap.value).toBe('5')
    fireEvent.change(cap, { target: { value: '20' } })
    fireEvent.blur(cap)
    await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith('th_1', { dailyCap: 20 }))

    api.patchThread.mockClear()
    api.getThread.mockResolvedValue({ thread: { ...THREAD, dailyCap: 20 }, posts: POSTS })
    fireEvent.change(cap, { target: { value: '' } })
    fireEvent.keyDown(cap, { key: 'Enter' })
    await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith('th_1', { dailyCap: null }))
  })

  test('an unchanged cap is not sent, and a bad value is refused without a request', async () => {
    api.getThread.mockResolvedValue({ thread: { ...THREAD, dailyCap: 5 }, posts: POSTS })
    render(<ThreadSection task={TASK} />)

    const cap = await screen.findByRole('spinbutton', { name: 'Daily cap per agent' })
    fireEvent.blur(cap)
    fireEvent.change(cap, { target: { value: '0' } })
    fireEvent.blur(cap)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(api.patchThread).not.toHaveBeenCalled()
  })

  test('a closed thread with a successor offers to open it', async () => {
    const closed = { ...THREAD, status: 'closed', closedAt: '2026-10-05T12:00:00.000Z', successorThreadId: 'th_2' }
    api.getThread.mockResolvedValue({ thread: closed, posts: POSTS })
    const onOpenTask = vi.fn()
    render(<ThreadSection task={TASK} onOpenTask={onOpenTask} />)

    const button = await screen.findByRole('button', { name: 'Open the successor thread' })
    expect(api.getThreadPosts).toHaveBeenCalledWith('th_2')
    fireEvent.click(button)
    expect(onOpenTask).toHaveBeenCalledWith('t_2')
  })

  test('a task holding third-party text gets no controls', async () => {
    api.getThread.mockResolvedValue({ thread: { ...THREAD, pinnedPostId: 'p_1' }, posts: POSTS })
    render(<ThreadSection task={{ ...TASK, untrustedText: true }} />)

    await screen.findByRole('list', { name: 'Posts' })
    expect(screen.queryByRole('group', { name: 'Thread settings' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Pinned state' })).toBeTruthy()
  })

  test('every control is off offline', async () => {
    api.getThread.mockResolvedValue({ thread: { ...THREAD, pinnedPostId: 'p_1' }, posts: POSTS })
    markOffline()
    render(<ThreadSection task={TASK} />)

    await screen.findByRole('list', { name: 'Posts' })
    for (const name of ['Close thread', 'Fork', 'Accept', 'Reject', 'Supersede', 'Pin']) {
      for (const button of screen.getAllByRole('button', { name })) expect(button.disabled).toBe(true)
    }
    expect(screen.getByRole('switch', { name: 'Hide authors from agents' }).disabled).toBe(true)
    expect(screen.getByRole('spinbutton', { name: 'Daily cap per agent' }).disabled).toBe(true)
    expect(screen.getByText('Offline. Posting needs the server.')).toBeTruthy()
  })
})
