import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import BoardTab from './BoardTab'
import UndoToast from '../UndoToast'
import { resetUndoToast } from './undoToast'

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
  resetUndoToast()
  localStorage.clear()
  Object.assign(api, {
    listProjects: vi.fn().mockResolvedValue({ projects: [project()] }),
    getProject: vi.fn().mockResolvedValue({ project: project(), sections: SECTIONS, tasks: boardTasks() }),
    moveTask: vi.fn().mockResolvedValue({}),
    completeTask: vi.fn().mockResolvedValue({}),
    reopenTask: vi.fn().mockResolvedValue({}),
    createTask: vi.fn().mockResolvedValue({ task: { id: 'new' } }),
    updateTask: vi.fn().mockResolvedValue({}),
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

  test('an Undo that fails after the Board has gone is shown by the toast, and Retry works', async () => {
    const view = render(<><BoardTab /><UndoToast /></>)
    const todo = await screen.findByRole('region', { name: 'Todo' })
    fireEvent.click(within(todo).getByRole('checkbox', { name: 'Complete Task One' }))
    const undo = await screen.findByRole('button', { name: 'Undo completing Task One' })
    await waitFor(() => expect(api.getProject).toHaveBeenCalledTimes(2))
    // App keeps the toast and unmounts the tab, as leaving the Board does.
    view.rerender(<>{null}<UndoToast /></>)
    expect(screen.queryByRole('region', { name: 'Todo' })).toBeNull()

    api.reopenTask.mockRejectedValueOnce(new Error('Server error'))
    fireEvent.click(undo)
    const retry = await screen.findByRole('button', { name: 'Retry reopening Task One' })
    expect(screen.getByRole('status').textContent).toContain('Could not reopen Task One')

    fireEvent.click(retry)
    await waitFor(() => expect(api.reopenTask).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry reopening Task One' })).toBeNull())
    expect(screen.getByRole('status').textContent).toBe('')
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

  test("completing a card shows the toast, and its Undo reopens the card's task", async () => {
    render(<><UndoToast /><BoardTab /></>)
    const todo = await screen.findByRole('region', { name: 'Todo' })
    fireEvent.click(within(todo).getByRole('checkbox', { name: 'Complete Task One' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo completing Task One' }))
    await waitFor(() => expect(api.reopenTask).toHaveBeenCalledWith('t1'))
    expect(screen.queryByRole('button', { name: 'Undo completing Task One' })).toBeNull()
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

  // Android puts the soft keyboard away when a focused box turns read-only, so the box stays
  // editable while a task saves, and a name typed meanwhile is kept for the next Enter.
  test("a lane's add box stays editable while a task saves, and keeps what was typed meanwhile", async () => {
    let finish
    api.createTask.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ task: { id: 'new' } }) }))
    render(<BoardTab />)
    const doing = await screen.findByRole('region', { name: 'Doing' })
    fireEvent.click(within(doing).getByRole('button', { name: 'Add task to Doing' }))
    const box = within(doing).getByRole('textbox', { name: 'New task in Doing' })
    fireEvent.change(box, { target: { value: 'First card' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(api.createTask).toHaveBeenCalledTimes(1)
    expect(box.readOnly).toBe(false)
    fireEvent.change(box, { target: { value: 'Second card' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(api.createTask).toHaveBeenCalledTimes(1)
    await act(async () => { finish() })
    const after = within(doing).getByRole('textbox', { name: 'New task in Doing' })
    expect(after.value).toBe('Second card')
  })

  // A click away starts a save; while it waits the box is editable, so a second name can be typed
  // there and the card left by a click again. That second name is saved once the first settles,
  // never dropped by the first save closing the card (review on #183).
  test('a name typed while a click-away save waits, then left by a click, is saved after it', async () => {
    const finishes = []
    api.createTask.mockImplementation(() => new Promise((resolve) => { finishes.push(() => resolve({ task: { id: 'new' } })) }))
    const clickAway = (box) => {
      fireEvent.pointerDown(document.body)
      act(() => { box.blur() })
      fireEvent.pointerUp(document.body)
    }
    render(<BoardTab />)
    const doing = await screen.findByRole('region', { name: 'Doing' })
    fireEvent.click(within(doing).getByRole('button', { name: 'Add task to Doing' }))
    const box = within(doing).getByRole('textbox', { name: 'New task in Doing' })
    await waitFor(() => expect(document.activeElement).toBe(box))
    fireEvent.change(box, { target: { value: 'First card' } })
    clickAway(box)
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ title: 'First card', projectId: 'p1', sectionId: 's2' }))
    act(() => { box.focus() })
    fireEvent.change(box, { target: { value: 'Second card' } })
    clickAway(box)
    await act(async () => { finishes[0]() })
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ title: 'Second card', projectId: 'p1', sectionId: 's2' }))
    expect(api.createTask).toHaveBeenCalledTimes(2)
    await act(async () => { finishes[1]() })
    await waitFor(() => expect(within(doing).queryByRole('textbox')).toBeNull())
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

  test("a click elsewhere saves a named card into the lane's section and closes it", async () => {
    render(<BoardTab />)
    const doing = await screen.findByRole('region', { name: 'Doing' })
    fireEvent.click(within(doing).getByRole('button', { name: 'Add task to Doing' }))
    const box = within(doing).getByRole('textbox', { name: 'New task in Doing' })
    await waitFor(() => expect(document.activeElement).toBe(box))
    fireEvent.change(box, { target: { value: 'Clicked away' } })
    fireEvent.pointerDown(document.body)
    act(() => { box.blur() })
    expect(api.createTask).not.toHaveBeenCalled()
    fireEvent.pointerUp(document.body)
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({ title: 'Clicked away', projectId: 'p1', sectionId: 's2' }))
    await waitFor(() => expect(within(doing).queryByRole('textbox')).toBeNull())
    expect(within(doing).getByRole('button', { name: 'Add task to Doing' })).toBeTruthy()
  })

  test("a click on the card's Cancel saves nothing", async () => {
    render(<BoardTab />)
    const doing = await screen.findByRole('region', { name: 'Doing' })
    fireEvent.click(within(doing).getByRole('button', { name: 'Add task to Doing' }))
    const box = within(doing).getByRole('textbox', { name: 'New task in Doing' })
    await waitFor(() => expect(document.activeElement).toBe(box))
    fireEvent.change(box, { target: { value: 'Never mind' } })
    const cancel = within(doing).getByRole('button', { name: 'Cancel' })
    fireEvent.pointerDown(cancel)
    act(() => { box.blur() })
    fireEvent.pointerUp(cancel)
    fireEvent.click(cancel)
    expect(within(doing).queryByRole('textbox')).toBeNull()
    expect(api.createTask).not.toHaveBeenCalled()
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

  test('right-click on a card opens the task menu, and its items use the board actions', async () => {
    render(<BoardTab />)
    await screen.findByRole('region', { name: 'Todo' })
    const card = document.querySelector('[data-task-id="t1"]')
    expect(fireEvent.contextMenu(card, { clientX: 20, clientY: 20 })).toBe(false)
    expect(screen.getByRole('menu', { name: 'Actions for Task One' })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Urgent' }))
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('t1', { priority: 'urgent' }))

    fireEvent.contextMenu(card)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Doing' }))
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith('t1', { section: 's2' }))

    fireEvent.contextMenu(document.querySelector('[data-task-id="t1"]'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Complete' }))
    await waitFor(() => expect(api.completeTask).toHaveBeenCalledWith('t1'))
  })

  test('Shift+F10 on a card opens the same menu', async () => {
    render(<BoardTab />)
    await screen.findByRole('region', { name: 'Todo' })
    const open = screen.getByRole('button', { name: 'Move Task One' })
    fireEvent.keyDown(open, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu', { name: 'Actions for Task One' })).toBeTruthy()
  })
})
