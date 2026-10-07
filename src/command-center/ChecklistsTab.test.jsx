import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ChecklistsTab from './ChecklistsTab'
import { markOffline, resetOfflineStatus } from './offlineStatus'

const api = {}
let connected = true

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))
// The task panel has tests of its own; here it only has to show which task it was opened on.
vi.mock('./TaskDetailPanel', () => ({
  default: ({ taskId, onClose }) => (
    <div role="dialog" aria-label="Task details">
      <span>{taskId}</span>
      <button type="button" onClick={onClose}>Close task details</button>
    </div>
  ),
}))

const serverChecklist = (over = {}) => ({
  id: 'cl_1', name: 'Packing: weekend trip', notes: '', items: ['Passport', 'Charger', 'Toothbrush', 'Book'],
  position: 1, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z', ...over,
})

beforeEach(() => {
  connected = true
  resetOfflineStatus()
  Object.assign(api, {
    listChecklists: vi.fn().mockResolvedValue({ checklists: [] }),
    createChecklist: vi.fn().mockResolvedValue({ checklist: serverChecklist() }),
    updateChecklist: vi.fn().mockResolvedValue({ checklist: serverChecklist() }),
    deleteChecklist: vi.fn().mockResolvedValue(undefined),
    startChecklist: vi.fn(),
    listProjects: vi.fn().mockResolvedValue({ projects: [{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Work' }] }),
  })
})

afterEach(() => {
  cleanup()
  resetOfflineStatus()
})

describe('ChecklistsTab', () => {
  test('asks for a connection instead of loading when there is none', () => {
    connected = false
    render(<ChecklistsTab />)
    expect(api.listChecklists).not.toHaveBeenCalled()
  })

  test('shows the empty state with a way forward', async () => {
    render(<ChecklistsTab />)
    expect(await screen.findByText('No checklists yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New checklist' })).toBeTruthy()
  })

  test('lists each checklist with its item count, a preview, and Start and Edit', async () => {
    api.listChecklists.mockResolvedValue({ checklists: [serverChecklist(), serverChecklist({ id: 'cl_2', name: 'Empty one', items: [] })] })
    render(<ChecklistsTab />)
    const row = await screen.findByRole('article', { name: 'Packing: weekend trip' })
    expect(row.textContent).toContain('4 items')
    expect(row.textContent).toContain('Passport, Charger, Toothbrush and 1 more')
    expect(within(row).getByRole('button', { name: 'Start Packing: weekend trip' }).disabled).toBe(false)
    const empty = screen.getByRole('article', { name: 'Empty one' })
    expect(empty.textContent).toContain('No items yet')
    expect(within(empty).getByRole('button', { name: 'Start Empty one' }).disabled).toBe(true)
  })

  test('create: name, items added with the button and with Enter, reordered and removed by buttons, then saved', async () => {
    render(<ChecklistsTab />)
    await screen.findByText('No checklists yet')
    fireEvent.click(screen.getByRole('button', { name: 'New checklist' }))
    const form = screen.getByRole('form', { name: 'New checklist' })
    expect(document.activeElement).toBe(within(form).getByLabelText('Name'))
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Clean the kitchen' } })

    const newItem = within(form).getByRole('textbox', { name: 'New item' })
    for (const text of ['Floor', 'Dishes', 'Counters']) {
      fireEvent.change(newItem, { target: { value: text } })
      if (text === 'Dishes') fireEvent.keyDown(newItem, { key: 'Enter' })
      else fireEvent.click(within(form).getByRole('button', { name: 'Add item' }))
    }
    expect(within(form).getByRole('textbox', { name: 'Item 3' }).value).toBe('Counters')
    expect(within(form).getByRole('button', { name: 'Move item 1 up' }).disabled).toBe(true)
    expect(within(form).getByRole('button', { name: 'Move item 3 down' }).disabled).toBe(true)

    // Floor goes to the bottom, then Counters is removed.
    fireEvent.click(within(form).getByRole('button', { name: 'Move item 1 down' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Move item 2 down' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Remove item 2' }))
    expect(['Item 1', 'Item 2'].map((n) => within(form).getByRole('textbox', { name: n }).value)).toEqual(['Dishes', 'Floor'])
    expect(document.activeElement).toBe(within(form).getByRole('textbox', { name: 'Item 2' }))

    api.listChecklists.mockResolvedValueOnce({ checklists: [serverChecklist({ id: 'new', name: 'Clean the kitchen', items: ['Dishes', 'Floor'] })] })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.createChecklist).toHaveBeenCalledWith({ name: 'Clean the kitchen', items: ['Dishes', 'Floor'] }))
    await screen.findByRole('article', { name: 'Clean the kitchen' })
    expect(screen.queryByRole('form', { name: 'New checklist' })).toBeNull()
  })

  test('an item typed but not yet added is saved too', async () => {
    render(<ChecklistsTab />)
    await screen.findByText('No checklists yet')
    fireEvent.click(screen.getByRole('button', { name: 'New checklist' }))
    const form = screen.getByRole('form', { name: 'New checklist' })
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Quick' } })
    fireEvent.change(within(form).getByRole('textbox', { name: 'New item' }), { target: { value: 'Only item' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.createChecklist).toHaveBeenCalledWith({ name: 'Quick', items: ['Only item'] }))
  })

  test('edit sends only what changed, and Esc closes the form without saving', async () => {
    api.listChecklists.mockResolvedValue({ checklists: [serverChecklist()] })
    render(<ChecklistsTab />)
    await screen.findByRole('article', { name: 'Packing: weekend trip' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit Packing: weekend trip' }))
    let form = screen.getByRole('form', { name: 'Edit Packing: weekend trip' })
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Changed' } })
    fireEvent.keyDown(within(form).getByLabelText('Name'), { key: 'Escape' })
    expect(screen.queryByRole('form', { name: 'Edit Packing: weekend trip' })).toBeNull()
    expect(api.updateChecklist).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Packing: weekend trip' }))
    form = screen.getByRole('form', { name: 'Edit Packing: weekend trip' })
    fireEvent.change(within(form).getByLabelText('Notes'), { target: { value: 'Check the forecast.' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Remove item 4' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateChecklist).toHaveBeenCalledWith('cl_1', { notes: 'Check the forecast.', items: ['Passport', 'Charger', 'Toothbrush'] }))
  })

  test('delete asks for a second click before it deletes', async () => {
    api.listChecklists.mockResolvedValue({ checklists: [serverChecklist()] })
    render(<ChecklistsTab />)
    await screen.findByRole('article', { name: 'Packing: weekend trip' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Packing: weekend trip' }))
    const form = screen.getByRole('form', { name: 'Edit Packing: weekend trip' })
    fireEvent.click(within(form).getByRole('button', { name: 'Delete checklist' }))
    expect(api.deleteChecklist).not.toHaveBeenCalled()
    api.listChecklists.mockResolvedValue({ checklists: [] })
    fireEvent.click(within(form).getByRole('button', { name: 'Delete checklist?' }))
    await waitFor(() => expect(api.deleteChecklist).toHaveBeenCalledWith('cl_1'))
    await screen.findByText('No checklists yet')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New checklist' }))
  })

  test('start asks for an optional due date and project, then opens the new task', async () => {
    api.listChecklists.mockResolvedValue({ checklists: [serverChecklist()] })
    api.startChecklist.mockResolvedValue({ task: { id: 't_new', title: 'Packing: Lisbon' }, subtasks: [{}, {}, {}, {}] })
    render(<ChecklistsTab />)
    await screen.findByRole('article', { name: 'Packing: weekend trip' })
    fireEvent.click(screen.getByRole('button', { name: 'Start Packing: weekend trip' }))
    const form = screen.getByRole('form', { name: 'Start Packing: weekend trip' })
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Home' })).toBeTruthy())
    expect(within(form).getByLabelText('Task title').value).toBe('Packing: weekend trip')
    fireEvent.change(within(form).getByLabelText('Task title'), { target: { value: 'Packing: Lisbon' } })
    fireEvent.change(within(form).getByLabelText('Due date (optional)'), { target: { value: '2026-10-09' } })
    fireEvent.change(within(form).getByLabelText('Project (optional)'), { target: { value: 'p1' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Start' }))

    await waitFor(() => expect(api.startChecklist).toHaveBeenCalledWith('cl_1', { title: 'Packing: Lisbon', dueAt: '2026-10-09', projectId: 'p1' }))
    const panel = await screen.findByRole('dialog', { name: 'Task details' })
    expect(panel.textContent).toContain('t_new')
    expect(screen.getByRole('status').textContent).toContain('Started Packing: Lisbon with 4 items.')
    expect(screen.queryByRole('form', { name: 'Start Packing: weekend trip' })).toBeNull()

    fireEvent.click(within(panel).getByRole('button', { name: 'Close task details' }))
    expect(screen.queryByRole('dialog', { name: 'Task details' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeTruthy()
  })

  test('start: "Bring the items back each time it repeats" is on by default, and turning it off is sent', async () => {
    api.listChecklists.mockResolvedValue({ checklists: [serverChecklist()] })
    api.startChecklist.mockResolvedValue({ task: { id: 't_new', title: 'Packing: weekend trip' }, subtasks: [{}] })
    render(<ChecklistsTab />)
    await screen.findByRole('article', { name: 'Packing: weekend trip' })
    fireEvent.click(screen.getByRole('button', { name: 'Start Packing: weekend trip' }))
    const form = screen.getByRole('form', { name: 'Start Packing: weekend trip' })
    const box = within(form).getByRole('checkbox', { name: 'Bring the items back each time it repeats' })
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(box.checked).toBe(false)
    fireEvent.click(within(form).getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(api.startChecklist).toHaveBeenCalledWith('cl_1', { repeatItems: false }))
  })

  test('start with nothing chosen sends an empty body, and a failure stays in the form', async () => {
    api.listChecklists.mockResolvedValue({ checklists: [serverChecklist()] })
    api.startChecklist.mockRejectedValueOnce(new Error('project p9 not found'))
    render(<ChecklistsTab />)
    await screen.findByRole('article', { name: 'Packing: weekend trip' })
    fireEvent.click(screen.getByRole('button', { name: 'Start Packing: weekend trip' }))
    const form = screen.getByRole('form', { name: 'Start Packing: weekend trip' })
    fireEvent.click(within(form).getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(api.startChecklist).toHaveBeenCalledWith('cl_1', {}))
    expect((await within(form).findByRole('alert')).textContent).toBe('project p9 not found')
    expect(screen.queryByRole('dialog', { name: 'Task details' })).toBeNull()
  })

  test('offline, every control that writes is off, and the list still shows', async () => {
    api.listChecklists.mockResolvedValue({ checklists: [serverChecklist()] })
    render(<ChecklistsTab />)
    await screen.findByRole('article', { name: 'Packing: weekend trip' })
    act(() => { markOffline() })
    expect(screen.getByRole('button', { name: 'New checklist' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Start Packing: weekend trip' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Edit Packing: weekend trip' }).disabled).toBe(true)
  })

  test('offline with a form already open, Save, Start, and Delete are off', async () => {
    api.listChecklists.mockResolvedValue({ checklists: [serverChecklist()] })
    render(<ChecklistsTab />)
    await screen.findByRole('article', { name: 'Packing: weekend trip' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Packing: weekend trip' }))
    act(() => { markOffline() })
    const form = screen.getByRole('form', { name: 'Edit Packing: weekend trip' })
    expect(within(form).getByRole('button', { name: 'Save' }).disabled).toBe(true)
    expect(within(form).getByRole('button', { name: 'Delete checklist' }).disabled).toBe(true)
    expect(within(form).getByRole('button', { name: 'Cancel' }).disabled).toBe(false)
  })

  test('a failed load shows the error with Retry', async () => {
    api.listChecklists.mockRejectedValueOnce(new Error('Server down'))
    render(<ChecklistsTab />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Server down')
    api.listChecklists.mockResolvedValueOnce({ checklists: [serverChecklist()] })
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await screen.findByRole('article', { name: 'Packing: weekend trip' })
  })
})
