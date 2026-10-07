import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ImportTasks from './ImportTasks'
import { markOffline, resetOfflineStatus } from './offlineStatus'

const api = {
  listProjects: vi.fn(),
  importTasks: vi.fn(),
}
const connection = { connected: true, api }
vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))

const PREVIEW = {
  format: 'lines',
  rows: [
    { line: 1, title: 'Book the venue', parentIndex: null, status: 'open' },
    { line: 2, title: 'Call three places', parentIndex: 0, status: 'open', dueAt: '2026-10-20' },
  ],
  errors: [],
  ignoredColumns: [],
  created: [],
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.listProjects.mockResolvedValue({ projects: [{ id: 'p1', slug: 'garden', name: 'Garden' }] })
  connection.connected = true
})

afterEach(() => {
  cleanup()
  resetOfflineStatus()
})

function type(text) {
  fireEvent.change(screen.getByLabelText('Tasks to import'), { target: { value: text } })
}

describe('ImportTasks', () => {
  test('asks for a connection when there is none', () => {
    connection.connected = false
    render(<ImportTasks />)
    expect(screen.getByText('Connect to a server to import tasks.')).toBeTruthy()
    expect(api.listProjects).not.toHaveBeenCalled()
  })

  test('previews with a dry run, then imports what was previewed', async () => {
    api.importTasks.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce({ count: 2, created: [{}, {}] })
    render(<ImportTasks />)
    await screen.findByRole('option', { name: 'Garden' })

    type('Book the venue\n  Call three places')
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'garden' } })
    expect(screen.getByRole('button', { name: 'Import' }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const list = await screen.findByRole('list', { name: 'Tasks to create' })
    expect(api.importTasks).toHaveBeenLastCalledWith({ text: 'Book the venue\n  Call three places', format: 'auto', project: 'garden', dryRun: true })
    expect(within(list).getByText('Call three places')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 tasks' }))
    await screen.findByText('Imported 2 tasks.')
    expect(api.importTasks).toHaveBeenLastCalledWith({ text: 'Book the venue\n  Call three places', format: 'auto', project: 'garden', dryRun: false })
    expect(screen.getByLabelText('Tasks to import').value).toBe('')
  })

  test('problems in the preview are listed by line and block the import', async () => {
    api.importTasks.mockResolvedValue({ ...PREVIEW, format: 'csv', errors: [{ line: 3, message: 'unknown priority "soon"' }] })
    render(<ImportTasks />)
    type('title,priority\nA,high\nB,soon')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const problems = await screen.findByRole('list', { name: 'Problems' })
    expect(problems.textContent).toContain('Line 3: unknown priority "soon"')
    expect(screen.getByRole('button', { name: 'Import 2 tasks' }).disabled).toBe(true)
  })

  test('editing the text after a preview asks for a new one before importing', async () => {
    api.importTasks.mockResolvedValue(PREVIEW)
    render(<ImportTasks />)
    type('Book the venue')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByRole('button', { name: 'Import 2 tasks' })
    type('Book the venue, and more')
    expect(screen.getByRole('button', { name: 'Import' }).disabled).toBe(true)
    expect(screen.getByText(/Preview again to import it/)).toBeTruthy()
  })

  test('a preview from one server does not import to another', async () => {
    api.importTasks.mockResolvedValue(PREVIEW)
    const apiB = {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      importTasks: vi.fn().mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce({ count: 2 }),
    }
    const { rerender } = render(<ImportTasks />)
    type('Book the venue')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByRole('button', { name: 'Import 2 tasks' })

    // Test connection & save on the Connection card replaces the client while this card stays mounted.
    connection.api = apiB
    try {
      rerender(<ImportTasks />)
      const importButton = screen.getByRole('button', { name: 'Import' })
      expect(importButton.disabled).toBe(true)
      expect(screen.queryByRole('region', { name: 'Import preview' })).toBeNull()
      expect(screen.getByText(/The server connection changed since the preview/)).toBeTruthy()
      fireEvent.click(importButton)
      expect(apiB.importTasks).not.toHaveBeenCalled()

      // A new dry run on the new server is what makes Import available again.
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
      await screen.findByRole('button', { name: 'Import 2 tasks' })
      expect(apiB.importTasks).toHaveBeenCalledTimes(1)
      expect(apiB.importTasks).toHaveBeenLastCalledWith({ text: 'Book the venue', format: 'auto', dryRun: true })
      fireEvent.click(screen.getByRole('button', { name: 'Import 2 tasks' }))
      await screen.findByText('Imported 2 tasks.')
      expect(apiB.importTasks).toHaveBeenLastCalledWith({ text: 'Book the venue', format: 'auto', dryRun: false })
      expect(api.importTasks).toHaveBeenCalledTimes(1)
    } finally {
      connection.api = api
    }
  })

  test('a preview that answers after the server changed is dropped', async () => {
    let answer
    api.importTasks.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const apiB = { listProjects: vi.fn().mockResolvedValue({ projects: [] }), importTasks: vi.fn() }
    const { rerender } = render(<ImportTasks />)
    type('Book the venue')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(api.importTasks).toHaveBeenCalledTimes(1))

    connection.api = apiB
    try {
      rerender(<ImportTasks />)
      answer(PREVIEW)
      await waitFor(() => expect(screen.getByLabelText('Tasks to import').disabled).toBe(false))
      expect(screen.queryByRole('region', { name: 'Import preview' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Import' }).disabled).toBe(true)
    } finally {
      connection.api = api
    }
  })

  test('a server error is shown and nothing is cleared', async () => {
    api.importTasks.mockRejectedValue(new Error('text is too long'))
    render(<ImportTasks />)
    type('x')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('text is too long')
    expect(screen.getByLabelText('Tasks to import').value).toBe('x')
  })

  test('is disabled offline', async () => {
    markOffline()
    render(<ImportTasks />)
    await waitFor(() => expect(screen.getByLabelText('Tasks to import').disabled).toBe(true))
    expect(screen.getByRole('button', { name: 'Preview' }).disabled).toBe(true)
  })
})
