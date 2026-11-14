import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import MyTasksTab from './MyTasksTab'
import { BREAKPOINT_QUERIES } from './columnsState'
import { getDueBounds } from './dueDates'
import UndoToast from '../UndoToast'
import { resetUndoToast } from './undoToast'

const api = {}
let connected = true

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))
// The poll's callback is kept so a test can fire a refresh at a chosen moment.
let refreshFromEvents = () => {}
vi.mock('./useEvents', () => ({ useEventRefresh: (cb) => { refreshFromEvents = cb } }))

const PHONE_QUERIES = Object.values(BREAKPOINT_QUERIES)

// jsdom has no window.matchMedia. This stub reports every breakpoint from one width and lets a
// test change that width and fire the change listeners, like a phone turned to landscape.
function stubMatchMedia(initialWidth) {
  let width = initialWidth
  const listeners = []
  window.matchMedia = vi.fn((query) => ({
    get matches() {
      const max = Number(/max-width: (\d+)px/.exec(query)?.[1] || 0)
      return PHONE_QUERIES.includes(query) ? width <= max : false
    },
    media: query,
    addEventListener: (event, cb) => listeners.push(cb),
    removeEventListener: (event, cb) => {
      const idx = listeners.indexOf(cb)
      if (idx !== -1) listeners.splice(idx, 1)
    },
  }))
  return {
    resize(next) {
      width = next
      act(() => listeners.slice().forEach((cb) => cb()))
    },
  }
}

beforeEach(() => {
  connected = true
  Object.assign(api, {
    listTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    listProjects: vi.fn().mockResolvedValue({ projects: [{ id: 'p1', name: 'Alpha', archived: false }] }),
    createTask: vi.fn().mockResolvedValue({ task: { id: 't1' } }),
  })
})

afterEach(() => {
  cleanup()
  delete window.matchMedia
})

// Opens the sheet from the floating button once the projects have loaded, and types a title.
async function openSheetWithDraft(title) {
  await waitFor(() => expect(api.listTasks).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: 'New task' }))
  await waitFor(() => expect(screen.getByRole('option', { name: 'Alpha' })).toBeTruthy())
  fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: title } })
}

describe('MyTasksTab share', () => {
  const SHARE = { title: '', text: 'Great read https://example.com/p', url: '' }

  test('a share opens the sheet prefilled and creating sends the link', async () => {
    stubMatchMedia(390)
    const onShareConsumed = vi.fn()
    render(<MyTasksTab share={SHARE} onShareConsumed={onShareConsumed} />)
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'New task name' }).value).toBe('Great read')
    expect(screen.getByText('Link: example.com/p')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({
      title: 'Great read', dueAt: null, notes: SHARE.text, sourceUrl: 'https://example.com/p',
    }))
    await waitFor(() => expect(onShareConsumed).toHaveBeenCalled())
    expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()
  })

  test('closing the sheet reports the share as consumed', () => {
    stubMatchMedia(390)
    const onShareConsumed = vi.fn()
    render(<MyTasksTab share={SHARE} onShareConsumed={onShareConsumed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close new task' }))
    expect(onShareConsumed).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()
  })

  test('a second share while the sheet is open replaces the draft, and only that share is consumed', async () => {
    stubMatchMedia(390)
    const onShareConsumed = vi.fn()
    const SECOND = { title: 'Second article', text: '', url: 'https://example.com/second' }
    const { rerender } = render(<MyTasksTab share={SHARE} onShareConsumed={onShareConsumed} />)
    expect(screen.getByRole('textbox', { name: 'New task name' }).value).toBe('Great read')
    rerender(<MyTasksTab share={SECOND} onShareConsumed={onShareConsumed} />)
    expect(screen.getByRole('textbox', { name: 'New task name' }).value).toBe('Second article')
    expect(screen.getByText('Link: example.com/second')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Second article', sourceUrl: 'https://example.com/second',
    })))
    await waitFor(() => expect(onShareConsumed).toHaveBeenCalled())
    expect(onShareConsumed).toHaveBeenCalledTimes(1)
    expect(onShareConsumed).toHaveBeenCalledWith(SECOND)
  })
})

describe('MyTasksTab focusTaskId', () => {
  test('opens the panel for that task and reports it consumed', async () => {
    stubMatchMedia(1280)
    api.getTask = vi.fn().mockResolvedValue({ task: { id: 't_abc123def4', title: 'Pay rent', status: 'open', priority: 'none', dueAt: null, notes: '' } })
    const onFocusTaskConsumed = vi.fn()
    render(<MyTasksTab focusTaskId="t_abc123def4" onFocusTaskConsumed={onFocusTaskConsumed} />)
    await waitFor(() => expect(onFocusTaskConsumed).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeTruthy()
  })
})

describe('MyTasksTab new task sheet', () => {
  test('an open sheet keeps its draft when the viewport crosses the 640px breakpoint', async () => {
    const media = stubMatchMedia(390)
    render(<MyTasksTab />)
    await openSheetWithDraft('Call the vet')
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'p1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'ask about teeth' } })

    media.resize(844)
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy()
    media.resize(390)

    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'New task name' }).value).toBe('Call the vet')
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('ask about teeth')
    expect(screen.getByRole('button', { name: 'Tomorrow' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('combobox', { name: 'Project' }).value).toBe('p1')
  })

  test('a task created with the sheet\'s default No date is shown: its collapsed group opens', async () => {
    // No due date and Later start collapsed. A task saved into a closed group is invisible,
    // which reads as a failed save, so the group is expanded before the list reloads.
    stubMatchMedia(390)
    const made = { id: 't9', title: 'Review default phone task', status: 'open', priority: 'none', dueAt: null, projectId: null }
    api.createTask.mockResolvedValue({ task: made })
    api.listTasks.mockResolvedValueOnce({ tasks: [] }).mockResolvedValue({ tasks: [made] })
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    try {
      render(<MyTasksTab />)
      await openSheetWithDraft(made.title)
      expect(screen.queryByRole('button', { name: 'Collapse No due date' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      await waitFor(() => expect(screen.getByRole('button', { name: `Open ${made.title}` })).toBeTruthy())
      expect(screen.getByRole('button', { name: 'Collapse No due date' })).toBeTruthy()
      expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()
      await waitFor(() => expect(scrolled).toHaveBeenCalled())
    } finally {
      delete Element.prototype.scrollIntoView
      localStorage.clear()
    }
  })

  test('a create that finishes after the sheet was closed and reopened does not close the new draft', async () => {
    stubMatchMedia(390)
    let resolveFirst
    api.createTask.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
    render(<MyTasksTab />)
    await openSheetWithDraft('Task A')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Close new task' }))
    expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Task B' } })

    await act(async () => {
      resolveFirst({ task: { id: 't1' } })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(api.listTasks).toHaveBeenCalledTimes(2))

    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'New task name' }).value).toBe('Task B')
  })
})

describe('MyTasksTab goal filter', () => {
  const VIEW_KEY = 'cc-mytasks-view-v1'
  const task = (id, title, projectId) => ({
    id, title, projectId, status: 'open', priority: 'none', dueAt: null, startAt: null, notes: '', sourceType: null,
  })
  const SHIP = { id: 'g1', title: 'Ship the installer', status: 'on_track', linkedWork: { projectIds: ['p1'], taskIds: ['t3'] } }

  function saveGoalFilter(goalIds) {
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      sort: { field: 'due', dir: 'asc' },
      group: 'none',
      filters: { projectIds: [], priorities: [], sources: [], goalIds },
    }))
  }

  afterEach(() => {
    localStorage.clear()
    delete api.listGoals
  })

  test('a saved goal filter whose goals fail to load says so and offers Retry, and recovers', async () => {
    stubMatchMedia(1280)
    saveGoalFilter(['g1'])
    api.listTasks.mockResolvedValue({ tasks: [task('t1', 'Sign the build', 'p1'), task('t2', 'Water the plants', null)] })
    api.listGoals = vi.fn().mockRejectedValueOnce(new Error('Request failed (500)'))
    render(<MyTasksTab />)

    // The failure is reported where the tasks would be, with the filter still counted.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The Goal filter is on, but the goals could not be loaded.')
    expect(alert.textContent).toContain('Request failed (500)')
    expect(screen.getByRole('button', { name: 'Filter: 1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Sign the build' })).toBeNull()

    // The chosen goal stays in the filter menu, so it can be switched off without the goals.
    fireEvent.click(screen.getByRole('button', { name: 'Filter: 1' }))
    expect(screen.getByRole('checkbox', { name: 'Goal not loaded' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })

    api.listGoals.mockResolvedValue({ goals: [SHIP] })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Open Sign the build' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Water the plants' })).toBeNull()
  })

  test('the list stays loading until the goals answer, rather than showing nothing', async () => {
    stubMatchMedia(1280)
    saveGoalFilter(['g1'])
    api.listTasks.mockResolvedValue({ tasks: [task('t1', 'Sign the build', 'p1')] })
    let answer
    api.listGoals = vi.fn().mockReturnValue(new Promise((resolve) => { answer = resolve }))
    render(<MyTasksTab />)

    await waitFor(() => expect(api.listTasks).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.getByText('Loading tasks…')).toBeTruthy()
    await act(async () => {
      answer({ goals: [SHIP] })
    })
    expect(screen.getByRole('button', { name: 'Open Sign the build' })).toBeTruthy()
    expect(screen.queryByText('Loading tasks…')).toBeNull()
  })

  // The goals answer with the projects and tasks linked to each goal; which tasks that covers is
  // decided from the list as it is now. So a task whose project was changed offline, which the
  // outbox patches into the cached list, moves out of the goal (or into it) before the server
  // has seen the edit.
  test('membership follows the task\'s current project, not a snapshot from the server', async () => {
    stubMatchMedia(1280)
    saveGoalFilter(['g1'])
    api.listGoals = vi.fn().mockResolvedValue({ goals: [SHIP] })
    api.listTasks.mockResolvedValue({ tasks: [
      task('t1', 'Moved out of the project', null), // was in p1 when the goals were fetched
      task('t2', 'Made in the project offline', 'p1'),
      task('t3', 'Linked by itself', null),
      task('t4', 'Unrelated', 'p2'),
    ] })
    render(<MyTasksTab />)

    expect(await screen.findByRole('button', { name: 'Open Made in the project offline' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Linked by itself' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Moved out of the project' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Unrelated' })).toBeNull()
  })
})

describe('MyTasksTab readiness filter', () => {
  const VIEW_KEY = 'cc-mytasks-view-v1'
  const task = (id, title) => ({
    id, title, projectId: null, status: 'open', priority: 'none', dueAt: null, startAt: null, notes: '', sourceType: null,
  })
  const TASKS = [task('t1', 'Free to start'), task('t2', 'Must finish first'), task('t3', 'Held back')]
  const READY = { view: { name: 'ready' }, tasks: [{ id: 't1' }, { id: 't2' }] }
  const BLOCKED = { view: { name: 'blocked' }, tasks: [{ id: 't3' }], blockers: { t3: [{ id: 't2', title: 'Must finish first' }] } }

  function saveStateFilter(states) {
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      sort: { field: 'due', dir: 'asc' },
      group: 'none',
      filters: { projectIds: [], priorities: [], sources: [], goalIds: [], states },
    }))
  }

  afterEach(() => {
    localStorage.clear()
    delete api.getView
  })

  test('the Filter menu offers Ready and Blocked, and choosing Ready keeps what the ready view returned', async () => {
    stubMatchMedia(1280)
    saveStateFilter([]) // a flat list, so undated tasks are not hidden in a collapsed group
    api.listTasks.mockResolvedValue({ tasks: TASKS })
    api.getView = vi.fn(async (name) => (name === 'ready' ? READY : BLOCKED))
    render(<MyTasksTab />)
    expect(await screen.findByRole('button', { name: 'Open Held back' })).toBeTruthy()
    // Nothing chosen: the views are not asked for.
    expect(api.getView).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    const ready = screen.getByRole('button', { name: 'Ready' })
    expect(screen.getByRole('button', { name: 'Blocked' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(ready)
    await waitFor(() => expect(api.getView).toHaveBeenCalledWith('ready'))
    expect(await screen.findByRole('button', { name: 'Open Free to start' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Must finish first' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Held back' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Filter: 1' })).toBeTruthy()
    expect(api.getView).not.toHaveBeenCalledWith('blocked')
  })

  test('a saved Blocked filter leaves only the blocked view\'s tasks, and Clear filters brings the rest back', async () => {
    stubMatchMedia(1280)
    saveStateFilter(['blocked'])
    api.listTasks.mockResolvedValue({ tasks: TASKS })
    api.getView = vi.fn(async (name) => (name === 'ready' ? READY : BLOCKED))
    render(<MyTasksTab />)
    expect(await screen.findByRole('button', { name: 'Open Held back' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Free to start' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Filter: 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByRole('button', { name: 'Open Free to start' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Held back' })).toBeTruthy()
  })

  test('a saved Ready filter whose view fails to load says so and offers Retry, and recovers', async () => {
    stubMatchMedia(1280)
    saveStateFilter(['ready'])
    api.listTasks.mockResolvedValue({ tasks: TASKS })
    api.getView = vi.fn().mockRejectedValueOnce(new Error('Request failed (500)'))
    render(<MyTasksTab />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The Ready filter is on, but its tasks could not be loaded.')
    expect(alert.textContent).toContain('Request failed (500)')
    expect(screen.getByRole('button', { name: 'Filter: 1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Free to start' })).toBeNull()

    api.getView.mockResolvedValue(READY)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Open Free to start' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Held back' })).toBeNull()
  })
})

describe('MyTasksTab assignee filter', () => {
  const task = (id, title, assignee) => ({
    id, title, projectId: null, status: 'open', priority: 'none', dueAt: null, startAt: null, notes: '', sourceType: null, assignee,
  })

  afterEach(() => {
    localStorage.clear()
  })

  test('Unassigned keeps only tasks with no assignee, names are listed from the tasks, and Clear filters brings everything back', async () => {
    stubMatchMedia(1280)
    // Ungrouped, so the rows are not behind a collapsed "No due date" group.
    localStorage.setItem('cc-mytasks-view-v1', JSON.stringify({ sort: { field: 'due', dir: 'asc' }, group: 'none', filters: {} }))
    api.listTasks.mockResolvedValue({ tasks: [
      task('t1', 'Sign the build', 'scribe'), task('t2', 'Water the plants', null), task('t3', 'File the receipts', undefined),
    ] })
    api.listGoals = vi.fn().mockResolvedValue({ goals: [] })
    render(<MyTasksTab />)
    expect(await screen.findByRole('button', { name: 'Open Sign the build' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    // The long groups are closed rows until opened; none has anything chosen yet.
    expect(screen.queryByRole('checkbox', { name: 'Unassigned' })).toBeNull()
    const assignee = screen.getByRole('button', { name: 'Assignee, any' })
    expect(assignee.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(assignee)
    const unassigned = screen.getByRole('checkbox', { name: 'Unassigned' })
    expect(unassigned.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('checkbox', { name: 'scribe' })).toBeTruthy()
    fireEvent.click(unassigned)

    expect(screen.getByRole('button', { name: 'Filter: 1' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Unassigned' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Open Sign the build' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open Water the plants' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open File the receipts' })).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Unassigned' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'scribe' }))
    expect(screen.getByRole('button', { name: 'Open Sign the build' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Water the plants' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Water the plants' })).toBeTruthy()
  })
})

describe('MyTasksTab manual sort', () => {
  const VIEW_KEY = 'cc-mytasks-view-v1'
  const task = (id, title, position) => ({
    id, title, position, projectId: null, status: 'open', priority: 'none', dueAt: null, startAt: null, notes: '', sourceType: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  })

  function saveSort(field) {
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      sort: { field, dir: 'asc' },
      group: 'none',
      filters: { projectIds: [], priorities: [], sources: [], goalIds: [] },
    }))
  }

  afterEach(() => localStorage.clear())

  test('under any other sort the rows have no handle', async () => {
    stubMatchMedia(1280)
    saveSort('due')
    api.listTasks.mockResolvedValue({ tasks: [task('t1', 'One', 1), task('t2', 'Two', 2)] })
    render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Open One' })
    expect(screen.queryByRole('button', { name: /^Reorder/ })).toBeNull()
  })

  test('under the manual sort a move sends the midpoint position, shows the new order at once, and reloads', async () => {
    stubMatchMedia(1280)
    saveSort('manual')
    api.listTasks.mockResolvedValue({ tasks: [task('t1', 'One', 1), task('t2', 'Two', 2), task('t3', 'Three', 3)] })
    api.moveTask = vi.fn().mockResolvedValue({ task: {} })
    render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder One' })
    const order = () => screen.getAllByRole('button', { name: /^Open / }).map((el) => el.getAttribute('aria-label'))
    expect(order()).toEqual(['Open One', 'Open Two', 'Open Three'])

    fireEvent.click(screen.getByRole('button', { name: 'Reorder Three' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }))
    expect(order()).toEqual(['Open One', 'Open Three', 'Open Two'])
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith('t3', { position: 1.5 }))
    await waitFor(() => expect(api.listTasks).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Reorder Three' })).toBeTruthy()
  })

  test('a move the server refuses puts the old order back and says why', async () => {
    stubMatchMedia(1280)
    saveSort('manual')
    api.listTasks.mockResolvedValue({ tasks: [task('t1', 'One', 1), task('t2', 'Two', 2)] })
    api.moveTask = vi.fn().mockRejectedValue(new Error('Request failed (503)'))
    render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder One' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Two' }), { key: 'ArrowUp' })
    await screen.findByText('Request failed (503)')
    expect(screen.getAllByRole('button', { name: /^Open / }).map((el) => el.getAttribute('aria-label'))).toEqual(['Open One', 'Open Two'])
  })
})

describe('MyTasksTab manual sort queues moves', () => {
  const VIEW_KEY = 'cc-mytasks-view-v1'
  const base = (id, title) => ({
    id, title, projectId: null, status: 'open', priority: 'none', dueAt: null, startAt: null, notes: '', sourceType: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  })
  const order = () => screen.getAllByRole('button', { name: /^Open / }).map((el) => el.getAttribute('aria-label'))

  afterEach(() => localStorage.clear())

  test('two quick moves of one task reach the server one after the other, and the list reloads once, in the final order', async () => {
    stubMatchMedia(1280)
    localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: { field: 'manual', dir: 'asc' }, group: 'none', filters: { projectIds: [], priorities: [], sources: [], goalIds: [] } }))
    // A server whose order is whatever the writes it has answered set, read back by the list.
    const positions = { t1: 1, t2: 2, t3: 3 }
    const pending = []
    api.listTasks.mockImplementation(() => Promise.resolve({
      tasks: [base('t1', 'One'), base('t2', 'Two'), base('t3', 'Three')].map((t) => ({ ...t, position: positions[t.id] })),
    }))
    api.moveTask = vi.fn((id, { position }) => new Promise((resolve) => {
      pending.push(() => { positions[id] = position; resolve({ task: {} }) })
    }))
    render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Three' })

    const handle = screen.getByRole('button', { name: 'Reorder Three' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    // Both moves show at once; only the first has gone to the server.
    expect(order()).toEqual(['Open Three', 'Open One', 'Open Two'])
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledTimes(1))
    expect(api.moveTask).toHaveBeenCalledWith('t3', { position: 1.5 })
    expect(api.listTasks).toHaveBeenCalledTimes(1)

    await act(async () => { pending.shift()() })
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledTimes(2))
    expect(api.moveTask).toHaveBeenLastCalledWith('t3', { position: 0 })
    // No reload between the two, so the order shown never slips back.
    expect(api.listTasks).toHaveBeenCalledTimes(1)
    expect(order()).toEqual(['Open Three', 'Open One', 'Open Two'])

    await act(async () => { pending.shift()() })
    await waitFor(() => expect(api.listTasks).toHaveBeenCalledTimes(2))
    expect(positions.t3).toBe(0)
    await waitFor(() => expect(order()).toEqual(['Open Three', 'Open One', 'Open Two']))
  })

  test('a poll between two queued moves keeps the later move on screen, so a third move goes on from it', async () => {
    stubMatchMedia(1280)
    localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: { field: 'manual', dir: 'asc' }, group: 'none', filters: { projectIds: [], priorities: [], sources: [], goalIds: [] } }))
    const positions = { t1: 1, t2: 2, t3: 3, t4: 4 }
    const pending = []
    api.listTasks.mockImplementation(() => Promise.resolve({
      tasks: [base('t1', 'One'), base('t2', 'Two'), base('t3', 'Three'), base('t4', 'Four')].map((t) => ({ ...t, position: positions[t.id] })),
    }))
    api.moveTask = vi.fn((id, { position }) => new Promise((resolve) => {
      pending.push(() => { positions[id] = position; resolve({ task: {} }) })
    }))
    render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Four' })

    const handle = screen.getByRole('button', { name: 'Reorder Four' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(order()).toEqual(['Open One', 'Open Four', 'Open Two', 'Open Three'])
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledTimes(1))

    // The first write lands (Four at 2.5), and the event it raises makes the list poll while the
    // second write (1.5) is still on its way. The server's in-between order must not show.
    await act(async () => { pending.shift()() })
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledTimes(2))
    await act(async () => { refreshFromEvents() })
    await waitFor(() => expect(api.listTasks).toHaveBeenCalledTimes(2))
    expect(order()).toEqual(['Open One', 'Open Four', 'Open Two', 'Open Three'])

    // A third step up goes on from where the row is shown, to the top.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Four' }), { key: 'ArrowUp' })
    expect(order()).toEqual(['Open Four', 'Open One', 'Open Two', 'Open Three'])
    await act(async () => { pending.shift()() })
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledTimes(3))
    await act(async () => { pending.shift()() })
    await waitFor(() => expect(api.listTasks).toHaveBeenCalledTimes(3))
    expect(api.moveTask.mock.calls.map((c) => c[1].position)).toEqual([2.5, 1.5, 0])
    expect(positions.t4).toBe(0)
    await waitFor(() => expect(order()).toEqual(['Open Four', 'Open One', 'Open Two', 'Open Three']))
  })
})

describe('MyTasksTab moves between due-date groups', () => {
  const VIEW_KEY = 'cc-mytasks-view-v1'
  const bounds = getDueBounds()
  const mk = (id, title, position, dueAt) => ({
    id, title, position, projectId: null, status: 'open', priority: 'none', dueAt, startAt: null, notes: '', sourceType: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  })
  const inGroup = (container, group) => Array.from(container.querySelectorAll(`[data-reorder-group="${group}"] [data-task-id]`)).map((el) => el.getAttribute('data-task-id'))

  beforeEach(() => {
    stubMatchMedia(1280)
    localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: { field: 'manual', dir: 'asc' }, group: 'due', filters: { projectIds: [], priorities: [], sources: [], goalIds: [] } }))
    api.listTasks.mockResolvedValue({
      tasks: [mk('a', 'Alpha', 1, `${bounds.today}T09:00`), mk('b', 'Beta', 2, bounds.tomorrow), mk('c', 'Gamma', 3, bounds.tomorrow)],
    })
    api.moveTask = vi.fn().mockResolvedValue({ task: {} })
    api.updateTask = vi.fn().mockResolvedValue({ task: {} })
  })
  afterEach(() => localStorage.clear())

  test('ArrowDown on the last row of Today moves it to the top of Tomorrow with that date, keeping its time', async () => {
    const { container } = render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Alpha' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Alpha' }), { key: 'ArrowDown' })
    expect(inGroup(container, 'tomorrow')).toEqual(['a', 'b', 'c'])
    // The row is a new element in its new group; its handle keeps the focus.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder Alpha' }))
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('a', { dueAt: `${bounds.tomorrow}T09:00` }))
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith('a', { position: 1 }))
  })

  test('ArrowUp on the first row of Tomorrow goes to the bottom of Today', async () => {
    const { container } = render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Beta' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Beta' }), { key: 'ArrowUp' })
    expect(inGroup(container, 'today')).toEqual(['a', 'b'])
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('b', { dueAt: bounds.today }))
  })

  test('an empty Today is hidden, and ArrowUp on the first row of Tomorrow still moves it there', async () => {
    api.listTasks.mockResolvedValue({ tasks: [mk('b', 'Beta', 2, bounds.tomorrow), mk('c', 'Gamma', 3, bounds.tomorrow)] })
    const { container } = render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Beta' })
    expect(screen.queryByRole('button', { name: 'Collapse Today' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Collapse Tomorrow' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Beta' }), { key: 'ArrowUp' })
    expect(inGroup(container, 'today')).toEqual(['b'])
    expect(screen.getByRole('button', { name: 'Collapse Today' })).toBeTruthy()
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('b', { dueAt: bounds.today }))
  })

  test('an empty Tomorrow is hidden, and ArrowDown on the last row of Today still moves it there', async () => {
    api.listTasks.mockResolvedValue({ tasks: [mk('a', 'Alpha', 1, `${bounds.today}T09:00`)] })
    const { container } = render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Alpha' })
    expect(screen.queryByRole('button', { name: 'Collapse Tomorrow' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Alpha' }), { key: 'ArrowDown' })
    expect(inGroup(container, 'tomorrow')).toEqual(['a'])
    expect(screen.queryByRole('button', { name: 'Collapse Today' })).toBeNull()
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('a', { dueAt: `${bounds.tomorrow}T09:00` }))
  })

  test('with no tasks no day group shows, and the toolbar keeps Add task', async () => {
    api.listTasks.mockResolvedValue({ tasks: [] })
    render(<MyTasksTab />)
    await waitFor(() => expect(api.listTasks).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Loading tasks…')).toBeNull())
    expect(screen.queryByRole('button', { name: /^(Collapse|Expand) / })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add task' })).toBeTruthy()
  })

  test('nothing moves into Overdue: ArrowUp on the first row of Today stays put, and Overdue rows can still leave', async () => {
    const yesterday = (() => { const [y, m, d] = bounds.today.split('-').map(Number); const t = new Date(y, m - 1, d - 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` })()
    api.listTasks.mockResolvedValue({
      tasks: [mk('o', 'Old', 0, yesterday), mk('a', 'Alpha', 1, `${bounds.today}T09:00`), mk('b', 'Beta', 2, bounds.tomorrow)],
    })
    const { container } = render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Alpha' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Alpha' }), { key: 'ArrowUp' })
    expect(inGroup(container, 'overdue')).toEqual(['o'])
    expect(inGroup(container, 'today')).toEqual(['a'])
    expect(api.updateTask).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Due date for Alpha' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Old' }), { key: 'ArrowDown' })
    expect(inGroup(container, 'today')).toEqual(['o', 'a'])
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('o', { dueAt: bounds.today }))
  })

  test('the handle menu moves a row to No due date, and leaves out the group it is in', async () => {
    const { container } = render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Beta' })
    fireEvent.click(screen.getByRole('button', { name: 'Reorder Beta' }))
    expect(screen.queryByRole('menuitem', { name: 'Move to Tomorrow' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Move to Today' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to No due date' }))
    expect(inGroup(container, 'noDue')).toEqual(['b'])
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('b', { dueAt: null }))
  })

  test('a move into Next 7 days opens the date picker on the moved row; Escape takes the move back', async () => {
    const { container } = render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Gamma' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Gamma' }), { key: 'ArrowDown' })
    await screen.findByRole('dialog', { name: 'Due date for Gamma' })
    expect(inGroup(container, 'next7')).toEqual(['c'])
    expect(api.updateTask).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Due date for Gamma' })).toBeNull())
    expect(inGroup(container, 'tomorrow')).toEqual(['b', 'c'])
    expect(api.updateTask).not.toHaveBeenCalled()
    expect(api.moveTask).not.toHaveBeenCalled()
    // The row is back in Tomorrow and its handle has the focus.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder Gamma' })))
  })

  test('a day picked outside the preview group leaves focus on the moved row handle', async () => {
    // A server that keeps what it was sent, so the reload after the write shows the new day.
    const list = (await api.listTasks()).tasks
    api.updateTask.mockImplementation(async (id, patch) => { Object.assign(list.find((t) => t.id === id), patch); return { task: {} } })
    api.listTasks.mockImplementation(async () => ({ tasks: list.map((t) => ({ ...t })) }))
    const { container } = render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Gamma' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Gamma' }), { key: 'ArrowDown' })
    const pop = await screen.findByRole('dialog', { name: 'Due date for Gamma' })
    fireEvent.click(within(pop).getByRole('button', { name: 'Today', exact: true }))
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('c', { dueAt: bounds.today }))
    await waitFor(() => expect(inGroup(container, 'today')).toContain('c'))
    await waitFor(() => expect(api.listTasks.mock.calls.length).toBeGreaterThan(2))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder Gamma' }))
  })

  test('picking a day in the picker saves the date and the position together', async () => {
    render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Gamma' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Gamma' }), { key: 'ArrowDown' })
    const pop = await screen.findByRole('dialog', { name: 'Due date for Gamma' })
    // The picker starts on the first day of the range: the day after tomorrow.
    fireEvent.click(within(pop).getByRole('button', { name: 'No date' }))
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('c', { dueAt: null }))
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith('c', { position: 0 }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder Gamma' }))
  })

  test('a failed write puts the date and the position back and says why', async () => {
    const { container } = render(<MyTasksTab />)
    api.updateTask.mockRejectedValue(new Error('Request failed (503)'))
    await screen.findByRole('button', { name: 'Reorder Alpha' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Alpha' }), { key: 'ArrowDown' })
    await screen.findByText('Request failed (503)')
    await waitFor(() => expect(inGroup(container, 'today')).toEqual(['a']))
    expect(api.moveTask).not.toHaveBeenCalled()
  })

  test('under another grouping the arrow keys stay inside the group', async () => {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: { field: 'manual', dir: 'asc' }, group: 'priority', filters: { projectIds: [], priorities: [], sources: [], goalIds: [] } }))
    render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Reorder Gamma' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Gamma' }), { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('button', { name: 'Reorder Alpha' }))
    expect(screen.queryByRole('menuitem', { name: 'Move to Today' })).toBeNull()
    expect(api.updateTask).not.toHaveBeenCalled()
  })
})

describe('MyTasksTab renaming in a row', () => {
  afterEach(() => localStorage.clear())

  test('clicking a title edits it, Enter saves it through updateTask, and a failed save puts the old name back', async () => {
    stubMatchMedia(1280)
    localStorage.setItem('cc-mytasks-view-v1', JSON.stringify({ sort: { field: 'manual', dir: 'asc' }, group: 'none', filters: { projectIds: [], priorities: [], sources: [], goalIds: [] } }))
    const base = { id: 't1', title: 'Old name', position: 1, projectId: null, status: 'open', priority: 'none', dueAt: null, startAt: null, notes: '', sourceType: null, createdAt: '2026-09-01T00:00:00.000Z' }
    api.listTasks.mockResolvedValue({ tasks: [base] })
    api.updateTask = vi.fn().mockResolvedValue({ task: {} })
    render(<MyTasksTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Old name' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task name' }), { target: { value: 'New name' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Task name' }), { key: 'Enter' })
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('t1', { title: 'New name' }))
    // The mocked list still answers with the old name once it reloads.
    await screen.findByRole('button', { name: 'Rename Old name' })

    api.updateTask.mockRejectedValue(new Error('Request failed (503)'))
    fireEvent.click(screen.getByRole('button', { name: 'Rename Old name' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task name' }), { target: { value: 'Third name' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Task name' }), { key: 'Enter' })
    await screen.findByText('Request failed (503)')
    expect(screen.getByRole('button', { name: 'Rename Old name' })).toBeTruthy()
  })
})

describe('MyTasksTab Add task with nothing in Today', () => {
  const task = (id, title, dueAt) => ({
    id, title, position: 1, projectId: null, status: 'open', priority: 'none', dueAt, startAt: null, notes: '', sourceType: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  })

  // Today is hidden while it is empty, but it is where the toolbar's Add task puts the new row, so
  // it comes back for as long as that row is open: with no tasks at all, and with tasks on other days.
  test.each([
    ['an empty list', () => []],
    ['a list with only a Tomorrow task', () => [task('t9', 'Later on', getDueBounds().tomorrow)]],
  ])('the toolbar Add task opens the inline row in Today for %s, and Enter creates the task for today', async (_label, tasks) => {
    stubMatchMedia(1280)
    api.listTasks.mockResolvedValue({ tasks: tasks() })
    render(<MyTasksTab />)
    await waitFor(() => expect(api.listTasks).toHaveBeenCalled())
    expect(screen.queryByRole('textbox', { name: 'New task name' })).toBeNull()
    // The toolbar's button is the first; a shown group has an Add task row of its own after it.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0])
    const input = await screen.findByRole('textbox', { name: 'New task name' })
    fireEvent.change(input, { target: { value: 'Call the vet' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Call the vet', dueAt: getDueBounds().today })))
  })
})

// A new task that sorts first (position 0) still shows under the rows that were there, until the
// row closes. Each list here answers as the server would, with the task in it.
describe('MyTasksTab Add task keeps new tasks just above the row until it closes', () => {
  const task = (id, title, position, dueAt) => ({
    id, title, position, projectId: null, status: 'open', priority: 'none', dueAt, startAt: null, notes: '', sourceType: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  })
  const view = (group) => localStorage.setItem('cc-mytasks-view-v1', JSON.stringify({
    sort: { field: 'manual', dir: 'asc' },
    group,
    filters: { projectIds: [], priorities: [], sources: [], goalIds: [] },
  }))
  const titles = () => screen.getAllByRole('button', { name: /^Open / }).map((b) => b.getAttribute('aria-label'))

  afterEach(() => localStorage.clear())

  async function addTwo() {
    const today = getDueBounds().today
    const list = [task('t1', 'Was here', 1, today)]
    api.listTasks.mockImplementation(async () => ({ tasks: [...list] }))
    api.createTask.mockImplementation(async ({ title }) => {
      const made = task(title === 'First' ? 't2' : 't3', title, title === 'First' ? 0 : -1, today)
      list.push(made)
      return { task: made }
    })
    stubMatchMedia(1280)
    render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Open Was here' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0])
    const input = await screen.findByRole('textbox', { name: 'New task name' })
    for (const title of ['First', 'Second']) {
      fireEvent.change(input, { target: { value: title } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await screen.findByRole('button', { name: `Open ${title}` })
      await waitFor(() => expect(input.value).toBe(''))
    }
    return input
  }

  test.each([['due'], ['none'], ['priority']])('grouped by %s', async (group) => {
    view(group)
    const input = await addTwo()
    expect(titles()).toEqual(['Open Was here', 'Open First', 'Open Second'])
    // The row is after every task in the document.
    const last = screen.getByRole('button', { name: 'Open Second' })
    expect(last.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'New task name' })).toBeNull())
    expect(titles()).toEqual(['Open Second', 'Open First', 'Open Was here'])
  })
})

// A second name typed while a click-away save waits, then left by a click, is added after the
// first is in the list, so its manual position puts it under the first, not above (review on
// #183). The server here answers as nextPosition does: a create with no position goes first.
describe('MyTasksTab Add task saves a name queued behind a click-away save in order', () => {
  const task = (id, title, position, dueAt) => ({
    id, title, position, projectId: null, status: 'open', priority: 'none', dueAt, startAt: null, notes: '', sourceType: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  })

  afterEach(() => localStorage.clear())

  test('starting from an empty Today, the two land in the order typed', async () => {
    localStorage.setItem('cc-mytasks-view-v1', JSON.stringify({ sort: { field: 'manual', dir: 'asc' }, group: 'due', filters: { projectIds: [], priorities: [], sources: [], goalIds: [] } }))
    const { today, tomorrow } = getDueBounds()
    const list = [task('t9', 'Later on', 1, tomorrow)]
    api.listTasks.mockImplementation(async () => ({ tasks: [...list] }))
    const finishes = []
    api.createTask.mockImplementation((payload) => new Promise((resolve) => {
      finishes.push(() => {
        const position = payload.position ?? Math.min(...list.map((t) => t.position)) - 1
        const made = task(`n${list.length}`, payload.title, position, payload.dueAt)
        list.push(made)
        resolve({ task: made })
      })
    }))
    stubMatchMedia(1280)
    render(<MyTasksTab />)
    await screen.findByRole('button', { name: 'Open Later on' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0])
    const input = await screen.findByRole('textbox', { name: 'New task name' })
    const clickAway = () => {
      fireEvent.pointerDown(document.body)
      act(() => { input.blur() })
      fireEvent.pointerUp(document.body)
    }
    fireEvent.change(input, { target: { value: 'First task' } })
    clickAway()
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1))
    act(() => { input.focus() })
    fireEvent.change(input, { target: { value: 'Second task' } })
    clickAway()
    await act(async () => { finishes[0]() })
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(2))
    expect(api.createTask.mock.calls[1][0]).toEqual(expect.objectContaining({ title: 'Second task', dueAt: today }))
    await act(async () => { finishes[1]() })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'New task name' })).toBeNull())
    const first = list.find((t) => t.title === 'First task')
    const second = list.find((t) => t.title === 'Second task')
    expect(second.position).toBeGreaterThan(first.position)
    const order = screen.getAllByRole('button', { name: /^Open (First|Second) task$/ }).map((b) => b.getAttribute('aria-label'))
    expect(order).toEqual(['Open First task', 'Open Second task'])
  })
})

describe('MyTasksTab Today group', () => {
  const todayIso = () => getDueBounds().today
  const open = (id) => ({ id, title: `Open ${id}`, status: 'open', priority: 'none', dueAt: todayIso(), projectId: null })

  test('Today shows a plain count, like every other group', async () => {
    stubMatchMedia(1280)
    api.listTasks.mockResolvedValue({ tasks: [open('a'), open('b')] })
    render(<MyTasksTab />)
    expect(await screen.findByRole('button', { name: 'Collapse Today' })).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.queryByText(/ left$/)).toBeNull()
    expect(screen.queryByText('All clear')).toBeNull()
  })

  test('an empty Today is hidden', async () => {
    stubMatchMedia(1280)
    api.listTasks.mockResolvedValue({ tasks: [] })
    render(<MyTasksTab />)
    await waitFor(() => expect(api.listTasks).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Collapse Today' })).toBeNull()
  })
})

describe('MyTasksTab due date picker across the breakpoint', () => {
  afterEach(() => {
    localStorage.clear()
  })

  test('an open picker keeps its unsaved time when the viewport crosses 640px, and nothing is written', async () => {
    const media = stubMatchMedia(390)
    localStorage.setItem('cc-mytasks-view-v1', JSON.stringify({ sort: { field: 'due', dir: 'asc' }, group: 'none', filters: {} }))
    const d = new Date()
    d.setDate(d.getDate() + 2)
    const dueAt = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    api.listTasks.mockResolvedValue({ tasks: [
      { id: 't1', title: 'Pay rent', projectId: null, status: 'open', priority: 'none', dueAt, startAt: null, notes: '', sourceType: null },
    ] })
    api.updateTask = vi.fn().mockResolvedValue({ task: { id: 't1' } })
    render(<MyTasksTab />)

    fireEvent.click(await screen.findByRole('button', { name: 'Change due date for Pay rent' }))
    const dialog = screen.getByRole('dialog', { name: 'Due date for Pay rent' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add time' }))
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '09:30' } })

    // The date is one cell in one place for both tiers, so turning the phone does not unmount the
    // picker, which would save what was typed as though the owner had left it.
    media.resize(844)
    expect(screen.getByRole('dialog', { name: 'Due date for Pay rent' })).toBeTruthy()
    expect(within(screen.getByRole('dialog', { name: 'Due date for Pay rent' })).getByLabelText('Time').value).toBe('09:30')
    media.resize(390)
    expect(screen.getByRole('dialog', { name: 'Due date for Pay rent' })).toBeTruthy()
    expect(api.updateTask).not.toHaveBeenCalled()
  })
})

describe('MyTasksTab move toast', () => {
  async function moveSoloToNoDate() {
    stubMatchMedia(1280)
    const bounds = getDueBounds()
    api.listTasks.mockResolvedValue({ tasks: [{ id: 's', title: 'Solo', status: 'open', priority: 'none', dueAt: bounds.today, projectId: null }] })
    let finish
    api.updateTask = vi.fn(() => new Promise((resolve) => { finish = () => resolve({ task: {} }) }))
    const view = render(<MyTasksTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change due date for Solo' }))
    const pop = await screen.findByRole('dialog', { name: 'Due date for Solo' })
    fireEvent.click(within(pop).getByRole('button', { name: 'No date' }))
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('s', { dueAt: null }))
    return { view, finish: () => finish() }
  }

  afterEach(() => resetUndoToast())

  test('a move that lands while the list is shown says where the task went', async () => {
    const { finish } = await moveSoloToNoDate()
    render(<UndoToast />)
    await act(async () => { finish() })
    await waitFor(() => expect(screen.getByRole('button', { name: 'View Solo in No due date' })).toBeTruthy())
  })

  // The owner left My tasks while the write was on its way: a toast then would offer a View that
  // acts on a list that is gone.
  test('a move that lands after the list has gone publishes no toast', async () => {
    const { view, finish } = await moveSoloToNoDate()
    view.unmount()
    render(<UndoToast />)
    await act(async () => { finish() })
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /^View Solo/ })).toBeNull()
  })
})
