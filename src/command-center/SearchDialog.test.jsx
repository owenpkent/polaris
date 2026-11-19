import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SearchDialog, { SEARCH_LIMIT, searchTasks } from './SearchDialog'
import { MY_TASKS_QUERY } from './api'
import { markOffline, resetOfflineStatus } from './offlineStatus'

const api = {
  listTasks: vi.fn(),
  listProjects: vi.fn(),
}
const connection = { connected: true, api }
vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))

const OPEN = { id: 't_1', title: 'Order the ramp', notes: '', status: 'open', projectId: 'p_1', dueAt: '2026-11-09' }
const DONE = { id: 't_2', title: 'Measure the ramp', notes: '', status: 'done', projectId: null, dueAt: null }

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.listProjects.mockResolvedValue({ projects: [{ id: 'p_1', name: 'House' }] })
  resetOfflineStatus()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetOfflineStatus()
})

function open(props = {}) {
  const onClose = vi.fn()
  const onOpenTask = vi.fn()
  render(<SearchDialog onClose={onClose} onOpenTask={onOpenTask} {...props} />)
  return { onClose, onOpenTask, box: screen.getByRole('textbox', { name: 'Search tasks' }) }
}

describe('the search dialog', () => {
  test('opens with focus in the box and says what to type', () => {
    const { box } = open()
    expect(document.activeElement).toBe(box)
    expect(screen.getByRole('status').textContent).toBe('Type two or more letters from the title or notes of a task.')
    expect(api.listTasks).not.toHaveBeenCalled()
  })

  test('one letter searches nothing', async () => {
    vi.useFakeTimers()
    const { box } = open()
    fireEvent.change(box, { target: { value: 'r' } })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(api.listTasks).not.toHaveBeenCalled()
  })

  test('asks the server for titles and notes, and lists what is still to do before what is done', async () => {
    api.listTasks.mockResolvedValue({ tasks: [DONE, OPEN] })
    const { box } = open()
    fireEvent.change(box, { target: { value: ' ramp ' } })

    const rows = await screen.findAllByRole('button', { name: /ramp/ })
    expect(api.listTasks).toHaveBeenCalledWith({ text: 'ramp', status: 'open,in_progress,waiting,done', orderBy: 'updated', limit: SEARCH_LIMIT })
    expect(rows.map((row) => row.textContent)).toEqual(['Order the rampHouse, due Nov 9', 'Measure the rampDone'])
    expect(screen.getByRole('status').textContent).toBe('2 tasks.')
  })

  test('choosing a result hands over its id', async () => {
    api.listTasks.mockResolvedValue({ tasks: [OPEN] })
    const { box, onOpenTask } = open()
    fireEvent.change(box, { target: { value: 'ramp' } })
    fireEvent.click(await screen.findByRole('button', { name: /Order the ramp/ }))
    expect(onOpenTask).toHaveBeenCalledWith('t_1')
  })

  test('says so when nothing matches', async () => {
    api.listTasks.mockResolvedValue({ tasks: [] })
    const { box } = open()
    fireEvent.change(box, { target: { value: 'zebra' } })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No tasks match.'))
  })

  test('a search that fills the limit says there may be more', async () => {
    const many = Array.from({ length: SEARCH_LIMIT }, (_, i) => ({ ...OPEN, id: `t_${i}`, title: `Ramp ${i}` }))
    api.listTasks.mockResolvedValue({ tasks: many })
    const { box } = open()
    fireEvent.change(box, { target: { value: 'ramp' } })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(`${SEARCH_LIMIT} tasks. These are the first ${SEARCH_LIMIT}: a longer word narrows it.`))
  })

  test('an answer for an earlier word does not replace the one for what is typed now', async () => {
    let answerFirst
    api.listTasks.mockImplementation(({ text }) => (text === 'ra'
      ? new Promise((resolve) => { answerFirst = resolve })
      : Promise.resolve({ tasks: [OPEN] })))
    const { box } = open()
    fireEvent.change(box, { target: { value: 'ra' } })
    await waitFor(() => expect(answerFirst).toBeTypeOf('function'))
    fireEvent.change(box, { target: { value: 'ramp' } })
    await screen.findByRole('button', { name: /Order the ramp/ })
    await act(async () => { answerFirst({ tasks: [DONE] }) })
    expect(screen.queryByRole('button', { name: /Measure the ramp/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Order the ramp/ })).toBeTruthy()
  })

  test('a server error is shown', async () => {
    api.listTasks.mockRejectedValue(Object.assign(new Error('invalid orderBy value'), { code: 'validation_error' }))
    const { box } = open()
    fireEvent.change(box, { target: { value: 'ramp' } })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('invalid orderBy value'))
  })

  test('Esc closes, and the key goes no further', () => {
    const { onClose } = open()
    const below = vi.fn()
    window.addEventListener('keydown', below)
    try {
      fireEvent.keyDown(document.activeElement, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(below).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', below)
    }
  })

  test('a click on the backdrop closes, a click in the dialog does not', () => {
    const { onClose } = open()
    fireEvent.click(screen.getByRole('dialog', { name: 'Search tasks' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog', { name: 'Search tasks' }).parentElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('Tab stays inside: from the last control it goes back to the box', async () => {
    api.listTasks.mockResolvedValue({ tasks: [OPEN] })
    const { box } = open()
    fireEvent.change(box, { target: { value: 'ramp' } })
    const row = await screen.findByRole('button', { name: /Order the ramp/ })
    act(() => { row.focus() })
    fireEvent.keyDown(row, { key: 'Tab' })
    expect(document.activeElement).toBe(box)
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(row)
  })
})

describe('with the server out of reach', () => {
  const copy = { tasks: [OPEN, { ...OPEN, id: 't_3', title: 'Call the plumber', notes: 'about the RAMP drain' }, { ...OPEN, id: 't_4', title: 'Unrelated', notes: '' }] }

  test('the copy of My tasks is searched, in titles and notes, and the dialog says only open tasks were', async () => {
    markOffline()
    api.listTasks.mockResolvedValue(copy)
    const { box } = open()
    fireEvent.change(box, { target: { value: 'ramp' } })

    const rows = await screen.findAllByRole('button', { name: /ramp|plumber/ })
    expect(api.listTasks).toHaveBeenCalledTimes(1)
    expect(api.listTasks).toHaveBeenCalledWith(MY_TASKS_QUERY)
    expect(rows).toHaveLength(2)
    expect(screen.getByRole('status').textContent).toBe('2 tasks. The server is out of reach, so only open tasks were searched.')
  })

  test('a search that finds the server gone falls back to the copy', async () => {
    const api2 = {
      listTasks: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('unreachable'), { code: 'network_error' }))
        .mockResolvedValueOnce(copy),
    }
    const res = await searchTasks(api2, 'plumber', false)
    expect(res.fromCopy).toBe(true)
    expect(res.tasks.map((task) => task.id)).toEqual(['t_3'])
  })

  test('any other failure is not hidden behind the copy', async () => {
    const api2 = { listTasks: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'unauthorized' })) }
    await expect(searchTasks(api2, 'ramp', false)).rejects.toThrow('nope')
    expect(api2.listTasks).toHaveBeenCalledTimes(1)
  })
})
