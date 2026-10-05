import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Sidebar from './Sidebar'

const listInbox = vi.fn()
vi.mock('./command-center/ConnectionContext', () => ({
  useConnection: () => ({ connected: true, api: { listInbox } }),
}))
vi.mock('./command-center/useEvents', () => ({ useEventRefresh: () => {} }))

const PRIMARY = [
  { id: 'mytasks', label: 'My tasks' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'board', label: 'Board' },
]
const MORE = [
  { id: 'goals', label: 'Goals' },
  { id: 'rules', label: 'Rules' },
]
const CONNECTION = { id: 'connection', label: 'Connection' }

function renderSidebar(props = {}) {
  return render(
    <Sidebar primaryItems={PRIMARY} moreItems={MORE} connectionItem={CONNECTION} activeTab="mytasks" onSelect={() => {}} {...props} />,
  )
}

afterEach(() => {
  cleanup()
  listInbox.mockReset()
})

describe('Sidebar', () => {
  test('lists every view with no menu to open, and marks the active one', () => {
    listInbox.mockResolvedValue({ tasks: [] })
    renderSidebar({ activeTab: 'goals' })
    const nav = screen.getByRole('navigation', { name: 'Navigation' })
    for (const label of ['My tasks', 'Inbox', 'Board', 'Goals', 'Rules']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: /^Connection/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Goals' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'My tasks' }).getAttribute('aria-current')).toBeNull()
  })

  test('switches view on click', () => {
    listInbox.mockResolvedValue({ tasks: [] })
    const onSelect = vi.fn()
    renderSidebar({ onSelect })
    fireEvent.click(screen.getByRole('button', { name: 'Rules' }))
    expect(onSelect).toHaveBeenCalledWith('rules')
  })

  test('shows how many inbox items wait', async () => {
    listInbox.mockResolvedValue({ tasks: [{ id: 1 }, { id: 2 }] })
    renderSidebar()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Inbox, 2 waiting' })).toBeTruthy())
  })
})
