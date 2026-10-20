import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    getProject: vi.fn().mockResolvedValue({ project: project(), sections: SECTIONS, tasks: boardTasks() }),
    moveTask: vi.fn().mockResolvedValue({}),
    completeTask: vi.fn().mockResolvedValue({}),
    reopenTask: vi.fn().mockResolvedValue({}),
    createTask: vi.fn().mockResolvedValue({ task: { id: 'new' } }),
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

  test("a card's check circle completes the task, and a done card's check reopens it", async () => {
    render(<BoardTab />)
    const todo = await screen.findByRole('region', { name: 'Todo' })
    const check = within(todo).getByRole('checkbox', { name: 'Complete Task One' })
    expect(check.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(check)
    await waitFor(() => expect(api.completeTask).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(api.getProject).toHaveBeenCalledTimes(2))

    fireEvent.click(within(todo).getByRole('button', { name: 'Show 1 done' }))
    fireEvent.click(within(todo).getByRole('checkbox', { name: 'Reopen Task Four' }))
    await waitFor(() => expect(api.reopenTask).toHaveBeenCalledWith('t4'))
  })

  test('a failed complete puts the card back and says so', async () => {
    api.completeTask.mockRejectedValueOnce(new Error('Could not update that task.'))
    render(<BoardTab />)
    const todo = await screen.findByRole('region', { name: 'Todo' })
    fireEvent.click(within(todo).getByRole('checkbox', { name: 'Complete Task One' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not update that task.')
    expect(within(todo).getByRole('checkbox', { name: 'Complete Task One' }).getAttribute('aria-checked')).toBe('false')
  })

  test('a card shows its due date in the words and colours the list uses', async () => {
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    api.getProject.mockResolvedValue({
      project: project(),
      sections: SECTIONS,
      tasks: [{ id: 't9', title: 'Due card', sectionId: 's1', status: 'open', priority: 'none', dueAt: iso }],
    })
    render(<BoardTab />)
    const todo = await screen.findByRole('region', { name: 'Todo' })
    const due = within(todo).getByText('Today')
    expect(due.style.color).toBe('var(--green)')
  })

  test("a lane's Add task creates a task in this project and that section, and stays open for the next", async () => {
    render(<BoardTab />)
    const doing = await screen.findByRole('region', { name: 'Doing' })
    fireEvent.click(within(doing).getByRole('button', { name: 'Add task to Doing' }))
    const box = within(doing).getByRole('textbox', { name: 'New task in Doing' })
    fireEvent.change(box, { target: { value: 'Fresh card' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ title: 'Fresh card', projectId: 'p1', sectionId: 's2' }))
    await waitFor(() => expect(within(doing).getByRole('textbox', { name: 'New task in Doing' }).value).toBe(''))
  })

  test('Add task in No section sends a null section, and Esc closes it', async () => {
    render(<BoardTab />)
    const lane = await screen.findByRole('region', { name: 'No section' })
    fireEvent.click(within(lane).getByRole('button', { name: 'Add task to No section' }))
    const box = within(lane).getByRole('textbox', { name: 'New task in No section' })
    fireEvent.change(box, { target: { value: 'Loose card' } })
    fireEvent.click(within(lane).getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ title: 'Loose card', projectId: 'p1', sectionId: null }))

    fireEvent.keyDown(within(lane).getByRole('textbox', { name: 'New task in No section' }), { key: 'Escape' })
    expect(within(lane).queryByRole('textbox')).toBeNull()
    expect(within(lane).getByRole('button', { name: 'Add task to No section' })).toBeTruthy()
  })

  // A second project, so a request can be left pending while the board is switched away from the
  // first. The answer for each project is keyed by the id the board asks for.
  function twoProjects() {
    const beta = { id: 'p2', name: 'Beta', counts: { open: 1 } }
    api.listProjects.mockResolvedValue({ projects: [project(), beta] })
    api.getProject.mockImplementation(async (id) => (id === 'p2'
      ? { project: beta, sections: [{ id: 's9', name: 'Later' }], tasks: [{ id: 'b1', title: 'Beta card', sectionId: 's9', status: 'open', priority: 'none', dueAt: null }] }
      : { project: project(), sections: SECTIONS, tasks: boardTasks() }))
  }

  // Lets the continuation after a resolved request run to its end (its awaits and the zero exit
  // delay jsdom gives a completion), so what it did, or did not, is on screen.
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

  test('a completion that finishes after a switch to another project does not bring the old board back', async () => {
    twoProjects()
    let finish
    api.completeTask.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<BoardTab />)
    const todo = await screen.findByRole('region', { name: 'Todo' })
    fireEvent.click(within(todo).getByRole('checkbox', { name: 'Complete Task One' }))
    await waitFor(() => expect(api.completeTask).toHaveBeenCalledWith('t1'))

    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'p2' } })
    const later = await screen.findByRole('region', { name: 'Later' })
    expect(within(later).getByText('Beta card')).toBeTruthy()

    finish()
    await settle()
    expect(screen.getByRole('combobox', { name: 'Project' }).value).toBe('p2')
    expect(within(screen.getByRole('region', { name: 'Later' })).getByText('Beta card')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Todo' })).toBeNull()
    expect(api.getProject.mock.calls.filter(([id]) => id === 'p1')).toHaveLength(1)
  })

  test('a create that finishes after a switch to another project leaves that project on the board, and the next Add task goes there', async () => {
    twoProjects()
    let finish
    api.createTask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    render(<BoardTab />)
    const todo = await screen.findByRole('region', { name: 'Todo' })
    fireEvent.click(within(todo).getByRole('button', { name: 'Add task to Todo' }))
    const box = within(todo).getByRole('textbox', { name: 'New task in Todo' })
    fireEvent.change(box, { target: { value: 'Slow card' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ title: 'Slow card', projectId: 'p1', sectionId: 's1' }))

    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'p2' } })
    await screen.findByRole('region', { name: 'Later' })

    finish({ task: { id: 'slow' } })
    await settle()
    expect(screen.getByRole('combobox', { name: 'Project' }).value).toBe('p2')
    expect(screen.queryByRole('region', { name: 'Todo' })).toBeNull()
    expect(api.getProject.mock.calls.filter(([id]) => id === 'p1')).toHaveLength(1)

    const later = screen.getByRole('region', { name: 'Later' })
    fireEvent.click(within(later).getByRole('button', { name: 'Add task to Later' }))
    const next = within(later).getByRole('textbox', { name: 'New task in Later' })
    fireEvent.change(next, { target: { value: 'Beta task' } })
    fireEvent.keyDown(next, { key: 'Enter' })
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ title: 'Beta task', projectId: 'p2', sectionId: 's9' }))
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
