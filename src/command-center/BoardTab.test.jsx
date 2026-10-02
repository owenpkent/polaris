import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import BoardTab from './BoardTab'

let connected = true
const api = {}

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))
// TaskDetailPanel has its own test file; stub it here so opening a card does not
// pull in its own network calls.
vi.mock('./TaskDetailPanel', () => ({ default: ({ taskId }) => <div data-testid="task-detail-panel">{taskId}</div> }))

const SECTIONS = [{ id: 's1', name: 'Todo' }, { id: 's2', name: 'Doing' }]

function boardTasks() {
  return [
    { id: 't1', title: 'Task One', sectionId: 's1', status: 'open', priority: 'none', dueAt: null },
    { id: 't2', title: 'Task Two', sectionId: 's2', status: 'open', priority: 'high', dueAt: null },
    { id: 't3', title: 'Task Three', sectionId: null, status: 'open', priority: 'none', dueAt: null },
    { id: 't4', title: 'Task Four', sectionId: 's1', status: 'done', priority: 'none', dueAt: null },
  ]
}

function project(over = {}) {
  return { id: 'p1', name: 'Alpha', counts: { open: 3 }, ...over }
}

beforeEach(() => {
  connected = true
  localStorage.clear()
  Object.assign(api, {
    listProjects: vi.fn().mockResolvedValue({ projects: [project()] }),
    getProject: vi.fn().mockResolvedValue({ sections: SECTIONS, tasks: boardTasks() }),
    moveTask: vi.fn().mockResolvedValue({}),
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('BoardTab', () => {
  test('lays tasks out in columns by section, plus a No section column for the rest', async () => {
    render(<BoardTab />)
    const todo = await screen.findByRole('region', { name: 'Todo' })
    expect(within(todo).getByText('Task One')).toBeTruthy()

    const doing = screen.getByRole('region', { name: 'Doing' })
    expect(within(doing).getByText('Task Two')).toBeTruthy()

    const noSection = screen.getByRole('region', { name: 'No section' })
    expect(within(noSection).getByText('Task Three')).toBeTruthy()
  })

  test('done tasks stay behind a Show done toggle', async () => {
    render(<BoardTab />)
    const todo = await screen.findByRole('region', { name: 'Todo' })
    expect(within(todo).queryByText('Task Four')).toBeNull()

    fireEvent.click(within(todo).getByRole('button', { name: 'Show 1 done' }))
    expect(within(todo).getByText('Task Four')).toBeTruthy()
  })

  test('a card is opened and moved by clicking, never by dragging', async () => {
    render(<BoardTab />)
    await screen.findByRole('region', { name: 'Todo' })
    const moveButton = screen.getByRole('button', { name: 'Move Task One' })
    expect(moveButton.closest('[draggable]')).toBeNull()
  })

  test('moving a card to another column calls the api with the new section', async () => {
    render(<BoardTab />)
    await screen.findByRole('region', { name: 'Todo' })

    fireEvent.click(screen.getByRole('button', { name: 'Move Task One' }))
    const menu = await screen.findByRole('menu', { name: 'Move Task One' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Doing' }))

    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith('t1', { section: 's2' }))
  })

  test('moving a card to No section sends a null section', async () => {
    render(<BoardTab />)
    await screen.findByRole('region', { name: 'Todo' })

    fireEvent.click(screen.getByRole('button', { name: 'Move Task One' }))
    const menu = await screen.findByRole('menu', { name: 'Move Task One' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'No section' }))

    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith('t1', { section: null }))
  })

  test("the card's own section is shown disabled with a check, not as a menu choice", async () => {
    render(<BoardTab />)
    await screen.findByRole('region', { name: 'Todo' })
    fireEvent.click(screen.getByRole('button', { name: 'Move Task One' }))
    const menu = await screen.findByRole('menu', { name: 'Move Task One' })
    const current = within(menu).getByText('Todo').closest('[role="menuitem"]')
    expect(current.getAttribute('aria-disabled')).toBe('true')
  })

  test('opening a card shows its detail panel', async () => {
    render(<BoardTab />)
    await screen.findByRole('region', { name: 'Todo' })
    fireEvent.click(screen.getByText('Task One'))
    expect((await screen.findByTestId('task-detail-panel')).textContent).toBe('t1')
  })

  test('a failed board load shows the error banner, and Retry loads again and clears it', async () => {
    api.getProject.mockRejectedValueOnce(new Error('Could not load this project.'))
    render(<BoardTab />)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('Could not load this project.')
    expect(screen.queryByRole('region', { name: 'Todo' })).toBeNull()

    // The second request answers, so the banner goes and the board is there.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api.getProject).toHaveBeenCalledTimes(2))
    const todo = await screen.findByRole('region', { name: 'Todo' })
    expect(within(todo).getByText('Task One')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('no projects yet shows the empty state instead of a board', async () => {
    api.listProjects.mockResolvedValue({ projects: [] })
    render(<BoardTab />)
    expect(await screen.findByText('No projects yet')).toBeTruthy()
    expect(api.getProject).not.toHaveBeenCalled()
  })

  test('not connected shows the connection form instead of loading a board', () => {
    connected = false
    render(<BoardTab />)
    expect(api.listProjects).not.toHaveBeenCalled()
    expect(screen.getByText('Connection settings')).toBeTruthy()
  })
})
