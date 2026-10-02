import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import BottomNav from './BottomNav'

const listInbox = vi.fn()
vi.mock('./command-center/ConnectionContext', () => ({
  useConnection: () => ({ connected: true, api: { listInbox } }),
}))
vi.mock('./command-center/useEvents', () => ({ useEventRefresh: () => {} }))

const ITEMS = [
  { id: 'mytasks', label: 'My tasks' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'board', label: 'Board' },
]

afterEach(() => {
  cleanup()
  listInbox.mockReset()
})

describe('BottomNav', () => {
  test('marks the active view and switches on click', () => {
    listInbox.mockResolvedValue({ tasks: [] })
    const onSelect = vi.fn()
    render(<BottomNav items={ITEMS} activeTab="mytasks" onSelect={onSelect} onMore={() => {}} moreOpen={false} />)
    expect(screen.getByRole('button', { name: 'My tasks' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-current')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Board' }))
    expect(onSelect).toHaveBeenCalledWith('board')
  })

  test('More hands its own button to the opener so focus can come back to it', () => {
    listInbox.mockResolvedValue({ tasks: [] })
    const onMore = vi.fn()
    render(<BottomNav items={ITEMS} activeTab="mytasks" onSelect={() => {}} onMore={onMore} moreOpen={false} />)
    const more = screen.getByRole('button', { name: 'More views' })
    fireEvent.click(more)
    expect(onMore).toHaveBeenCalledWith(more)
    expect(more.getAttribute('aria-expanded')).toBe('false')
  })

  test('the Inbox item carries the count of waiting suggestions', async () => {
    listInbox.mockResolvedValue({ tasks: [{ id: 'a' }, { id: 'b' }] })
    render(<BottomNav items={ITEMS} activeTab="mytasks" onSelect={() => {}} onMore={() => {}} moreOpen={false} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Inbox, 2 waiting' })).toBeTruthy())
  })

  test('an empty inbox shows no count', async () => {
    listInbox.mockResolvedValue({ tasks: [] })
    render(<BottomNav items={ITEMS} activeTab="mytasks" onSelect={() => {}} onMore={() => {}} moreOpen={false} />)
    await waitFor(() => expect(listInbox).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy()
  })
})
