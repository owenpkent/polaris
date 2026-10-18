import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TaskDetailPanel from './TaskDetailPanel'
import { markOffline, markOnline, resetOfflineStatus } from './offlineStatus'
import { resetDefaultAgentNameCache } from './defaultAgentName'
import { weekdayOf } from './recurrenceRules'

const api = {
  getTask: vi.fn(),
  getProject: vi.fn(),
  restoreTask: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  reopenTask: vi.fn(),
  listGoals: vi.fn(),
  linkGoal: vi.fn(),
  unlinkGoal: vi.fn(),
  getAgentSettings: vi.fn(),
  getThread: vi.fn(),
  saveTaskAsChecklist: vi.fn(),
  previewRecurrence: vi.fn(),
  skipOccurrence: vi.fn(),
}
const connection = { connected: true, api }
vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))

const TASK = {
  id: 't_1', title: 'Current title', notes: 'Saved notes', status: 'open', priority: 'none',
  dueAt: null, recurrence: null, projectId: null, sectionId: null, sourceType: 'manual',
}
const at = '2026-09-24T10:00:00.000Z'

function detail(task, history, goals = []) {
  return { task, subtasks: [], blockers: [], blocking: [], comments: [], links: [], history, goals }
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  resetDefaultAgentNameCache()
  api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'claude-code' })
  api.getThread.mockResolvedValue(null)
  api.previewRecurrence.mockResolvedValue({ dates: [] })
})

afterEach(() => {
  cleanup()
  delete connection.local
})

// Resolves after the browser's next animation frame has run, which is when a Popover focuses.
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

async function openHistory() {
  render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'More details' }))
}

// A promise the test settles by hand, to hold a request open while it types.
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

describe('saving keeps drafts in other fields', () => {
  test('a priority change still out does not throw away notes typed meanwhile', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, []))
    const save = deferred()
    api.updateTask.mockReturnValue(save.promise)
    api.getTask.mockResolvedValue(detail({ ...TASK, priority: 'high' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    fireEvent.change(await screen.findByRole('combobox', { name: 'Priority' }), { target: { value: 'high' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Typed while saving' } })
    await act(async () => { save.resolve({ task: { ...TASK, priority: 'high' } }) })

    expect(api.updateTask).toHaveBeenCalledWith('t_1', { priority: 'high' })
    expect(screen.getByRole('combobox', { name: 'Priority' }).value).toBe('high')
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('Typed while saving')
  })

  test('a saved title shows as the server stored it, not as it was typed', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, title: 'Trimmed title' } })
    api.getTask.mockResolvedValue(detail({ ...TASK, title: 'Trimmed title' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const title = await screen.findByRole('textbox', { name: 'Task title' })
    fireEvent.change(title, { target: { value: '  Trimmed title  ' } })
    await act(async () => { fireEvent.blur(title) })

    expect(api.updateTask).toHaveBeenCalledWith('t_1', { title: 'Trimmed title' })
    expect(screen.getByRole('textbox', { name: 'Task title' }).value).toBe('Trimmed title')
  })

  test('completing the task keeps a notes draft and does not blank the panel', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, []))
    const complete = deferred()
    api.completeTask.mockReturnValue(complete.promise)
    api.getTask.mockResolvedValue(detail({ ...TASK, status: 'done' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Last thought' } })
    await act(async () => { complete.resolve({ task: { ...TASK, status: 'done' } }) })

    expect(screen.getByRole('button', { name: 'Completed' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('Last thought')
    expect(screen.queryByText('Loading task…')).toBeNull()
  })
})

describe('Put back', () => {
  test('keeps text typed into another field while the restore is out', async () => {
    const edit = { id: 7, at, kind: 'task.updated', taskId: 't_1', actor: 'human', payload: { changes: { title: ['Old title', 'Current title'] } }, restore: { title: 'Old title' } }
    api.getTask.mockResolvedValueOnce(detail(TASK, [edit]))
    let finish
    api.restoreTask.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    api.getTask.mockResolvedValue(detail({ ...TASK, title: 'Old title' }, [edit]))
    await openHistory()

    fireEvent.click(screen.getByRole('button', { name: 'Put back title to "Old title"' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'New notes being typed' } })
    await act(async () => { finish({ task: { ...TASK, title: 'Old title' } }) })

    expect(api.restoreTask).toHaveBeenCalledWith('t_1', 7)
    expect(screen.getByRole('textbox', { name: 'Task title' }).value).toBe('Old title')
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('New notes being typed')
  })

  test('two conflicts from one replay say which field and value each puts back', async () => {
    const conflict = (id, field, kept, discarded) => ({
      id, at, kind: 'task.sync_conflict', taskId: 't_1', actor: 'system', payload: { field, kept, discarded, opId: 'op_1' }, restore: { [field]: discarded },
    })
    api.getTask.mockResolvedValue(detail(TASK, [
      conflict(8, 'title', 'Current title', 'Phone title'),
      conflict(9, 'notes', 'Saved notes', ''),
    ]))
    await openHistory()

    expect(screen.getByRole('button', { name: 'Put back title to "Phone title"' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Put back notes to empty' })).toBeTruthy()
    expect(screen.getByText(/kept "Current title", discarded "Phone title"/)).toBeTruthy()
  })
})

describe('Goals row', () => {
  const SHIP = { id: 'g_1', title: 'Ship the installer', status: 'on_track' }
  const SIGN = { id: 'g_2', title: 'Sign it', status: 'on_track' }

  test('lists the linked goals, and removing one unlinks it and reloads', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, [], [SHIP]))
    api.getTask.mockResolvedValue(detail(TASK, [], []))
    api.unlinkGoal.mockResolvedValue({})
    const onChanged = vi.fn()
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} onChanged={onChanged} />)

    expect(await screen.findByText('Ship the installer')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove from goal Ship the installer' }))
    })
    expect(api.unlinkGoal).toHaveBeenCalledWith('g_1', { taskId: 't_1' })
    expect(screen.queryByText('Ship the installer')).toBeNull()
    expect(onChanged).toHaveBeenCalled()
  })

  test('Add to goal offers the open goals not already linked, and picking one links it', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, [], [SHIP]))
    api.getTask.mockResolvedValue(detail(TASK, [], [SHIP, SIGN]))
    api.listGoals.mockResolvedValue({ goals: [SHIP, SIGN] })
    api.linkGoal.mockResolvedValue({})
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const add = await screen.findByRole('button', { name: 'Add to goal' })
    await act(async () => {
      fireEvent.click(add)
    })
    const menu = screen.getByRole('menu', { name: 'Add to goal' })
    expect(menu.textContent).not.toContain('Ship the installer')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign it' }))
    })
    expect(api.linkGoal).toHaveBeenCalledWith('g_2', { taskId: 't_1' })
    expect(await screen.findByText('Sign it')).toBeTruthy()
  })

  // The menu opens on a loading header while the goals are fetched. A keyboard user must still
  // reach the choices once they arrive: focus moves to the first, the arrow keys move between
  // them, Enter picks one, and Escape puts focus back on Add to goal.
  test('choices that arrive after the menu opened take focus, and the keyboard works them', async () => {
    const user = userEvent.setup()
    api.getTask.mockResolvedValue(detail(TASK, [], []))
    let answer
    api.listGoals.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    api.linkGoal.mockResolvedValue({})
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const add = await screen.findByRole('button', { name: 'Add to goal' })
    add.focus()
    await user.keyboard('{Enter}')
    const menu = screen.getByRole('menu', { name: 'Add to goal' })
    expect(menu.textContent).toContain('Loading goals')
    // The frame on which the menu would focus its first item passes with only the header there.
    await act(() => nextFrame())
    expect(document.activeElement).toBe(add)

    await act(async () => {
      answer({ goals: [SHIP, SIGN] })
    })
    const first = screen.getByRole('menuitem', { name: 'Ship the installer' })
    await waitFor(() => expect(document.activeElement).toBe(first))

    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Sign it' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'Add to goal' })).toBeNull()
    expect(document.activeElement).toBe(add)

    // Open again, now with the goals answering at once, and pick one with Enter.
    api.listGoals.mockResolvedValue({ goals: [SHIP, SIGN] })
    api.getTask.mockResolvedValue(detail(TASK, [], [SIGN]))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Ship the installer' })))
    await user.keyboard('{ArrowDown}{Enter}')
    expect(api.linkGoal).toHaveBeenCalledWith('g_2', { taskId: 't_1' })
    expect(await screen.findByRole('button', { name: 'Remove from goal Sign it' })).toBeTruthy()
    expect(screen.queryByRole('menu', { name: 'Add to goal' })).toBeNull()
  })

  test('a failed link says so and leaves the goals as they were', async () => {
    api.getTask.mockResolvedValue(detail(TASK, [], []))
    api.listGoals.mockResolvedValue({ goals: [SIGN] })
    api.linkGoal.mockRejectedValue(new Error('Could not reach the Command Center server.'))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const add = await screen.findByRole('button', { name: 'Add to goal' })
    await act(async () => {
      fireEvent.click(add)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign it' }))
    })
    expect(screen.getByText('Could not reach the Command Center server.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove from goal Sign it' })).toBeNull()
  })

  test('without a server the goal controls are off, since goal links are never queued', async () => {
    connection.local = true
    api.getTask.mockResolvedValue(detail(TASK, [], [SHIP]))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    expect((await screen.findByRole('button', { name: 'Add to goal' })).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Remove from goal Ship the installer' }).disabled).toBe(true)
  })

  test('a copy saved before tasks carried goals shows none', async () => {
    const { goals, ...old } = detail(TASK, [])
    api.getTask.mockResolvedValue(old)
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    expect(await screen.findByRole('button', { name: 'Add to goal' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Remove from goal/ })).toBeNull()
  })
})

describe('assignee field', () => {
  test('shows the stored assignee in a labelled text box and saves a new name on blur, trimmed', async () => {
    api.getTask.mockResolvedValueOnce(detail({ ...TASK, assignee: 'scribe' }, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: 'reviewer' } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: 'reviewer' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const input = await screen.findByRole('textbox', { name: 'Assignee' })
    expect(input.value).toBe('scribe')
    expect(input.labels?.[0]?.textContent).toBe('Assignee')

    fireEvent.change(input, { target: { value: '  reviewer ' } })
    await act(async () => { fireEvent.blur(input) })

    expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: 'reviewer' })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Assignee' }).value).toBe('reviewer'))
  })

  test('Enter saves like blur, and a name that did not change sends nothing', async () => {
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: 'scribe' }, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: 'scribe' } })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const input = await screen.findByRole('textbox', { name: 'Assignee' })
    input.focus()
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(api.updateTask).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'reviewer' } })
    input.focus()
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: 'reviewer' })
  })

  test('an unassigned task shows the placeholder and no clear button, and typing a name assigns it', async () => {
    api.getTask.mockResolvedValueOnce(detail({ ...TASK, assignee: null }, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: 'scribe' } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: 'scribe' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const input = await screen.findByRole('textbox', { name: 'Assignee' })
    expect(input.value).toBe('')
    expect(input.getAttribute('placeholder')).toBe('Unassigned')
    expect(screen.queryByRole('button', { name: 'Clear assignee' })).toBeNull()

    fireEvent.change(input, { target: { value: 'scribe' } })
    await act(async () => { fireEvent.blur(input) })
    expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: 'scribe' })
    await screen.findByRole('button', { name: 'Clear assignee' })
  })

  test('the clear button is a 44px target that sends null and empties the box', async () => {
    api.getTask.mockResolvedValueOnce(detail({ ...TASK, assignee: 'scribe' }, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: null } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: null }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const clear = await screen.findByRole('button', { name: 'Clear assignee' })
    expect(clear.style.width).toBe('44px')
    expect(clear.style.height).toBe('44px')
    await act(async () => { fireEvent.click(clear) })

    expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: null })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Assignee' }).value).toBe(''))
    expect(screen.queryByRole('button', { name: 'Clear assignee' })).toBeNull()
  })

  test('blanking the name and leaving the field clears it with null', async () => {
    api.getTask.mockResolvedValueOnce(detail({ ...TASK, assignee: 'scribe' }, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: null } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: null }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const input = await screen.findByRole('textbox', { name: 'Assignee' })
    fireEvent.change(input, { target: { value: '   ' } })
    await act(async () => { fireEvent.blur(input) })
    expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: null })
  })

  test('an assignee change still out does not throw away notes typed meanwhile', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, []))
    const save = deferred()
    api.updateTask.mockReturnValue(save.promise)
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: 'scribe' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const input = await screen.findByRole('textbox', { name: 'Assignee' })
    fireEvent.change(input, { target: { value: 'scribe' } })
    fireEvent.blur(input)
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Typed while saving' } })
    await act(async () => { save.resolve({ task: { ...TASK, assignee: 'scribe' } }) })

    expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: 'scribe' })
    expect(screen.getByRole('textbox', { name: 'Assignee' }).value).toBe('scribe')
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('Typed while saving')
  })
})

describe('Assign to AI', () => {
  afterEach(() => resetOfflineStatus())

  test('an unassigned task offers "Assign to <default name>", and clicking it claims the task', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: 'claude-code' } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: 'claude-code' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const assign = await screen.findByRole('button', { name: 'Assign to claude-code' })
    await act(async () => { fireEvent.click(assign) })

    expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: 'claude-code' })
    await screen.findByTitle('claude-code')
  })

  test('the label uses the name the server gives as the default agent', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'scribe' })
    api.getTask.mockResolvedValue(detail(TASK, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    expect(await screen.findByRole('button', { name: 'Assign to scribe' })).toBeTruthy()
  })

  test('while the name is still loading, a click reads it first and never assigns a fallback', async () => {
    api.getAgentSettings.mockReset()
    api.getAgentSettings
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({ defaultAgentName: 'scribe' })
    api.getTask.mockResolvedValueOnce(detail(TASK, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: 'scribe' } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: 'scribe' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const assign = await screen.findByRole('button', { name: 'Assign to agent' })
    await act(async () => { fireEvent.click(assign) })

    expect(api.updateTask).toHaveBeenCalledTimes(1)
    expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: 'scribe' })
    await screen.findByTitle('scribe')
  })

  test('if the name cannot be loaded, a click assigns nothing and says so', async () => {
    api.getAgentSettings.mockRejectedValue(new Error('offline'))
    api.getTask.mockResolvedValue(detail(TASK, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const assign = await screen.findByRole('button', { name: 'Assign to agent' })
    await act(async () => { fireEvent.click(assign) })

    expect(api.updateTask).not.toHaveBeenCalled()
    expect(await screen.findByText('Could not load the default agent name. Try again.')).toBeTruthy()
  })

  test('after Assign, the Assignee box shows the name, and leaving it untouched sends nothing', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: 'claude-code' } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: 'claude-code' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const button = await screen.findByRole('button', { name: 'Assign to claude-code' })
    await act(async () => { fireEvent.click(button) })
    await screen.findByTitle('claude-code')
    const box = screen.getByLabelText('Assignee')
    expect(box.value).toBe('claude-code')

    await act(async () => { fireEvent.focus(box); fireEvent.blur(box) })
    expect(api.updateTask).toHaveBeenCalledTimes(1)
  })

  test('after Take back, the Assignee box is empty, and leaving it untouched sends nothing', async () => {
    api.getTask.mockResolvedValueOnce(detail({ ...TASK, assignee: 'scribe' }, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: null } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: null }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const button = await screen.findByRole('button', { name: 'Take back' })
    await act(async () => { fireEvent.click(button) })
    await screen.findByRole('button', { name: 'Assign to claude-code' })
    const box = screen.getByLabelText('Assignee')
    expect(box.value).toBe('')

    await act(async () => { fireEvent.focus(box); fireEvent.blur(box) })
    expect(api.updateTask).toHaveBeenCalledTimes(1)
  })

  test('an assigned task shows a chip and Take back, which clears the assignee', async () => {
    api.getTask.mockResolvedValueOnce(detail({ ...TASK, assignee: 'scribe' }, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: null } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: null }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    expect(await screen.findByText('Assigned to scribe')).toBeTruthy()
    const takeBack = screen.getByRole('button', { name: 'Take back' })
    await act(async () => { fireEvent.click(takeBack) })

    expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: null })
    await screen.findByRole('button', { name: 'Assign to claude-code' })
  })

  test('an inbox task shows no Assign button', async () => {
    api.getTask.mockResolvedValue(detail({ ...TASK, status: 'inbox' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    await screen.findByRole('textbox', { name: 'Assignee' })
    expect(screen.queryByRole('button', { name: /^Assign to/ })).toBeNull()
  })

  test('a task with untrusted text shows no Assign button', async () => {
    api.getTask.mockResolvedValue(detail({ ...TASK, untrustedText: true }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    await screen.findByRole('textbox', { name: 'Assignee' })
    expect(screen.queryByRole('button', { name: /^Assign to/ })).toBeNull()
  })

  test('an assigned task with untrusted text still shows Take back', async () => {
    api.getTask.mockResolvedValue(detail({ ...TASK, untrustedText: true, assignee: 'scribe' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    expect(await screen.findByText('Assigned to scribe')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Take back' })).toBeTruthy()
  })

  test('after Assign, focus moves to Take back and the change is announced', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: 'claude-code' } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: 'claude-code' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const assign = await screen.findByRole('button', { name: 'Assign to claude-code' })
    await act(async () => { fireEvent.click(assign) })

    const takeBack = await screen.findByRole('button', { name: 'Take back' })
    await waitFor(() => expect(document.activeElement).toBe(takeBack))
    expect(screen.getByRole('status').textContent).toBe('Assigned to claude-code')
  })

  test('after Take back, focus moves to Assign and the change is announced', async () => {
    api.getTask.mockResolvedValueOnce(detail({ ...TASK, assignee: 'scribe' }, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: null } })
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: null }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    const takeBack = await screen.findByRole('button', { name: 'Take back' })
    await act(async () => { fireEvent.click(takeBack) })

    const assign = await screen.findByRole('button', { name: 'Assign to claude-code' })
    await waitFor(() => expect(document.activeElement).toBe(assign))
    expect(screen.getByRole('status').textContent).toBe('Assignment cleared')
  })

  test('offline, Assign to AI is disabled', async () => {
    api.getTask.mockResolvedValue(detail(TASK, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    const assign = await screen.findByRole('button', { name: 'Assign to claude-code' })

    act(() => markOffline())
    expect(assign.disabled).toBe(true)
  })

  test('offline, Take back is disabled too', async () => {
    api.getTask.mockResolvedValue(detail({ ...TASK, assignee: 'scribe' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    const takeBack = await screen.findByRole('button', { name: 'Take back' })

    act(() => markOffline())
    expect(takeBack.disabled).toBe(true)
  })

  test('a history entry with an actor name shows it next to the actor', async () => {
    const edit = {
      id: 5, at, kind: 'task.updated', taskId: 't_1', actor: 'agent', actorName: 'scribe',
      payload: { changes: { assignee: [null, 'scribe'] } },
    }
    api.getTask.mockResolvedValue(detail(TASK, [edit]))
    await openHistory()

    expect(screen.getByText(/agent scribe task\.updated/)).toBeTruthy()
  })

  test('a comment with an author name shows it after the author', async () => {
    const comment = { id: 'c_1', taskId: 't_1', author: 'agent', authorName: 'scribe', body: 'Started on this.', createdAt: at }
    api.getTask.mockResolvedValue({ ...detail(TASK, []), comments: [comment] })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    expect(await screen.findByText('agent scribe', { exact: false })).toBeTruthy()
  })
})

describe('save as checklist', () => {
  const SUBS = [
    { id: 't_s1', title: 'Passport', status: 'done' },
    { id: 't_s2', title: 'Charger', status: 'open' },
  ]

  test('a task with subtasks offers it, and saving says where the checklist went', async () => {
    api.getTask.mockResolvedValue({ ...detail(TASK, []), subtasks: SUBS })
    api.saveTaskAsChecklist.mockResolvedValue({ checklist: { id: 'cl_1', name: 'Current title', items: ['Passport', 'Charger'] } })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save as checklist' }))
    await waitFor(() => expect(api.saveTaskAsChecklist).toHaveBeenCalledWith('t_1'))
    expect((await screen.findByText(/Saved as the checklist "Current title"/)).getAttribute('role')).toBe('status')
  })

  test('a task with no subtasks, or with third-party text, does not offer it', async () => {
    api.getTask.mockResolvedValueOnce(detail(TASK, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    await screen.findByText('No subtasks.')
    expect(screen.queryByRole('button', { name: 'Save as checklist' })).toBeNull()
    cleanup()

    api.getTask.mockResolvedValueOnce({ ...detail({ ...TASK, untrustedText: true, sourceType: 'github' }, []), subtasks: SUBS })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    await screen.findByRole('checkbox', { name: 'Reopen Passport' })
    expect(screen.queryByRole('button', { name: 'Save as checklist' })).toBeNull()
  })

  test('offline, the button is off: a checklist write is never queued', async () => {
    api.getTask.mockResolvedValue({ ...detail(TASK, []), subtasks: SUBS })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    const button = await screen.findByRole('button', { name: 'Save as checklist' })
    act(() => { markOffline() })
    expect(button.disabled).toBe(true)
    resetOfflineStatus()
  })

  test('a refusal from the server is shown, not swallowed', async () => {
    api.getTask.mockResolvedValue({ ...detail(TASK, []), subtasks: SUBS })
    api.saveTaskAsChecklist.mockRejectedValue(new Error('this task holds text written by a third party'))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save as checklist' }))
    expect(await screen.findByText(/written by a third party/)).toBeTruthy()
  })
})

describe('the due date menu and the focus trap', () => {
  // The menu is portalled to <body>, outside the panel. The panel's Tab trap must leave focus
  // alone there, or Tab in the date box jumps to Mark complete instead of the next segment.
  test('Tab and Shift+Tab inside the date box are left to the browser', async () => {
    api.getTask.mockResolvedValue(detail({ ...TASK, dueAt: '2026-10-08' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Due date, / }))
    const input = screen.getByLabelText('Date')
    input.focus()
    // fireEvent returns false when a listener called preventDefault.
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(document.activeElement).toBe(input)
  })

  test('Tab from outside the panel, with no menu open, is still pulled into it', async () => {
    api.getTask.mockResolvedValue(detail(TASK, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    const dialog = await screen.findByRole('dialog', { name: 'Task details' })
    document.activeElement?.blur?.()
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false)
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})

// The title is a textarea that grows with its text, so a long title is read in full in the panel
// (CONTRIBUTING.md, "Nothing is cut off"). It still behaves as one line.
describe('TaskDetailPanel title box', () => {
  afterEach(() => {
    cleanup()
  })

  test('is a textarea, so a long title wraps instead of being cut at the edge', async () => {
    api.getTask.mockResolvedValue(detail(TASK, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    const title = await screen.findByRole('textbox', { name: 'Task title' })
    expect(title.tagName).toBe('TEXTAREA')
    expect(title.style.overflowWrap).toBe('anywhere')
  })

  test('Enter saves the title instead of starting a new line', async () => {
    api.getTask.mockResolvedValue(detail(TASK, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, title: 'Renamed' } })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    const title = await screen.findByRole('textbox', { name: 'Task title' })
    await userEvent.clear(title)
    await userEvent.type(title, 'Renamed{Enter}')
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('t_1', { title: 'Renamed' }))
    expect(title.value).not.toContain('\n')
  })

  test('a pasted line break becomes a space', async () => {
    api.getTask.mockResolvedValue(detail(TASK, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    const title = await screen.findByRole('textbox', { name: 'Task title' })
    fireEvent.change(title, { target: { value: 'First line\nsecond line' } })
    expect(title.value).toBe('First line second line')
  })
})

describe('TaskDetailPanel assignee box', () => {
  afterEach(() => {
    cleanup()
  })

  test('grows with its text like the title, and Enter saves', async () => {
    api.getTask.mockResolvedValue(detail(TASK, []))
    api.updateTask.mockResolvedValue({ task: { ...TASK, assignee: 'reviewer' } })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    const box = await screen.findByRole('textbox', { name: 'Assignee' })
    expect(box.tagName).toBe('TEXTAREA')
    await userEvent.type(box, 'reviewer{Enter}')
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('t_1', { assignee: 'reviewer' }))
    expect(box.value).not.toContain('\n')
  })
})

describe('TaskDetailPanel repeating tasks', () => {
  const REPEATING = { ...TASK, dueAt: '2026-10-17', recurrence: 'weekly' }

  test('Custom opens the builder and Save updates the recurrence', async () => {
    api.getTask.mockResolvedValue(detail(TASK, []))
    api.updateTask.mockResolvedValue({ task: TASK })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Repeat, never' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Custom' }))
    const dialog = await screen.findByRole('group', { name: 'Custom repeat' })
    expect(dialog).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // No due date, so the builder starts on today's weekday and writes it out.
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('t_1', { recurrence: `FREQ=WEEKLY;INTERVAL=2;BYDAY=${weekdayOf(null)}` }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Custom repeat' })).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Repeat, / }))
  })

  // "weekly" on its own repeats on the due date's weekday. The builder stays open while the due
  // date changes, so it saves the weekday it shows, not whatever the new due date falls on.
  test('Custom keeps the weekday it shows when the due date changes under it', async () => {
    const task = { ...TASK, dueAt: '2026-10-14', recurrence: 'weekly' }
    api.getTask.mockResolvedValue(detail(task, []))
    api.previewRecurrence.mockResolvedValue({ dates: ['2026-10-21'] })
    api.updateTask.mockImplementation((id, patch) => Promise.resolve({ task: { ...task, ...patch } }))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Repeat, / }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Custom' }))
    const group = await screen.findByRole('group', { name: 'Custom repeat' })

    fireEvent.click(screen.getByRole('button', { name: /^Due date, / }))
    const input = screen.getByLabelText('Date')
    fireEvent.change(input, { target: { value: '2026-10-16' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('t_1', { dueAt: '2026-10-16' }))

    expect(within(group).getByRole('button', { name: 'Wednesday' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(group).getByRole('button', { name: 'Friday' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(group).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('t_1', { recurrence: 'FREQ=WEEKLY;BYDAY=WE' }))
  })

  // Opened in the panel, the builder closes on Esc and leaves the panel open.
  test('Esc closes the custom repeat builder, not the panel', async () => {
    api.getTask.mockResolvedValue(detail(TASK, []))
    const onClose = vi.fn()
    render(<TaskDetailPanel taskId="t_1" onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Repeat, never' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Custom' }))
    const group = await screen.findByRole('group', { name: 'Custom repeat' })
    fireEvent.keyDown(group.querySelector('select'), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Custom repeat' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(api.updateTask).not.toHaveBeenCalled()
  })

  test('shows the next date and Skip this one moves the task on', async () => {
    api.getTask.mockResolvedValue(detail(REPEATING, []))
    api.previewRecurrence.mockResolvedValue({ dates: ['2026-10-24'] })
    api.skipOccurrence.mockResolvedValue({ task: { ...REPEATING, dueAt: '2026-10-24' } })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    expect(await screen.findByText('Sat, Oct 24')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skip this one' }))

    await waitFor(() => expect(api.skipOccurrence).toHaveBeenCalledWith('t_1'))
    expect(await screen.findByText('Skipped. Now due Sat, Oct 24.')).toBeTruthy()
  })

  // Opened offline with nothing cached, the preview fails; when the server is back the Next line
  // and Skip fill in without the panel being closed and opened again (review on #66).
  test('a preview that failed offline is asked again once back online', async () => {
    api.getTask.mockResolvedValue(detail(REPEATING, []))
    api.previewRecurrence.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ dates: ['2026-10-24'] })
    act(() => markOffline())
    try {
      render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
      expect(await screen.findByText('Shown when online.')).toBeTruthy()
      await waitFor(() => expect(api.previewRecurrence).toHaveBeenCalledTimes(1))
      act(() => markOnline())
      expect(await screen.findByText('Sat, Oct 24')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Skip this one' }).disabled).toBe(false)
      expect(api.previewRecurrence).toHaveBeenCalledTimes(2)
    } finally {
      resetOfflineStatus()
    }
  })

  // 2026-10-17 is the third Saturday of October.
  test('the Repeat menu offers quick picks worded from the due date, and an alias shows as its pick', async () => {
    api.getTask.mockResolvedValue(detail(REPEATING, []))
    api.updateTask.mockResolvedValue({ task: REPEATING })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Repeat, weekly' }))
    const items = await screen.findAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual([
      'Does not repeat', 'Daily', 'Every weekday (Monday to Friday)', 'Weekends', 'Weekly on Saturday',
      'Every 2 weeks on Saturday', 'Monthly on day 17', 'Monthly on the third Saturday', 'Every 3 months on day 17',
      'Annually on October 17', 'Custom',
    ])
    expect(screen.getByRole('menuitemradio', { name: 'Weekly on Saturday' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Monthly on the third Saturday' }))
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith('t_1', { recurrence: 'FREQ=MONTHLY;BYDAY=3SA' }))
  })

  test('a rule with an end shows as Custom in the Repeat menu', async () => {
    api.getTask.mockResolvedValue(detail({ ...REPEATING, recurrence: 'FREQ=WEEKLY;BYDAY=SA;COUNT=3' }, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Repeat, weekly on Sat, 3 more times' }))
    expect((await screen.findByRole('menuitemradio', { name: 'Custom' })).getAttribute('aria-checked')).toBe('true')
  })

  test('a rule counted from the finish says so on the Next row, with the date a skip moves it to', async () => {
    api.getTask.mockResolvedValue(detail({ ...REPEATING, recurrence: 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION' }, []))
    api.previewRecurrence.mockResolvedValue({ dates: ['2026-10-20'] })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    expect(await screen.findByText('Counted from the day you finish it. Skipping moves it to Tue, Oct 20.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Repeat, every 3 days after you finish it' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Skip this one' })).toBeTruthy()
  })

  test('no Next row for a task that does not repeat', async () => {
    api.getTask.mockResolvedValue(detail(TASK, []))
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)
    await screen.findByRole('textbox', { name: 'Task title' })
    expect(screen.queryByRole('button', { name: 'Skip this one' })).toBeNull()
  })

  test('completing a repeating task names the next due date', async () => {
    api.getTask.mockResolvedValue(detail(REPEATING, []))
    api.completeTask.mockResolvedValue({ task: { ...REPEATING, status: 'done' }, next: { dueAt: '2026-10-24' } })
    render(<TaskDetailPanel taskId="t_1" onClose={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))

    expect(await screen.findByText('Done. The next one is due Sat, Oct 24.')).toBeTruthy()
  })
})
