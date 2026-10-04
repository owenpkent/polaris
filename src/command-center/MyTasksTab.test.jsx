import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MyTasksTab from './MyTasksTab'

const api = {}
let connected = true

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))

const PHONE_QUERIES = ['(max-width: 900px)', '(max-width: 600px)', '(max-width: 640px)']

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
      expect(scrolled).toHaveBeenCalled()
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
    expect(screen.getByRole('button', { name: 'Filter (1)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Sign the build' })).toBeNull()

    // The chosen goal stays in the filter menu, so it can be switched off without the goals.
    fireEvent.click(screen.getByRole('button', { name: 'Filter (1)' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Goal not loaded' }).getAttribute('aria-checked')).toBe('true')
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
    const ready = screen.getByRole('menuitemcheckbox', { name: 'Ready' })
    expect(screen.getByRole('menuitemcheckbox', { name: 'Blocked' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(ready)
    await waitFor(() => expect(api.getView).toHaveBeenCalledWith('ready'))
    expect(await screen.findByRole('button', { name: 'Open Free to start' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Must finish first' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Held back' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Filter (1)' })).toBeTruthy()
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

    fireEvent.click(screen.getByRole('button', { name: 'Filter (1)' }))
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
    expect(screen.getByRole('button', { name: 'Filter (1)' })).toBeTruthy()
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
    const unassigned = screen.getByRole('menuitemcheckbox', { name: 'Unassigned' })
    expect(unassigned.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemcheckbox', { name: 'scribe' })).toBeTruthy()
    fireEvent.click(unassigned)

    expect(screen.getByRole('button', { name: 'Filter (1)' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Unassigned' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Open Sign the build' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open Water the plants' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open File the receipts' })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unassigned' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'scribe' }))
    expect(screen.getByRole('button', { name: 'Open Sign the build' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Water the plants' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Water the plants' })).toBeTruthy()
  })
})
