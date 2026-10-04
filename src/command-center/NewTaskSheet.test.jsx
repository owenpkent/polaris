import { describe, test, expect, vi, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NewTaskSheet from './NewTaskSheet'
import { getDueBounds } from './dueDates'

const PROJECTS = [{ id: 'p1', name: 'Alpha' }]

afterEach(cleanup)

function renderSheet(props = {}) {
  const onCreate = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const utils = render(<NewTaskSheet open onClose={onClose} onCreate={onCreate} projects={PROJECTS} {...props} />)
  return { ...utils, onCreate, onClose }
}

describe('NewTaskSheet', () => {
  test('renders nothing while closed', () => {
    render(<NewTaskSheet open={false} onClose={() => {}} onCreate={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('focuses the title and creates with the chosen date, project, and notes', async () => {
    const { onCreate } = renderSheet()
    const title = screen.getByRole('textbox', { name: 'New task name' })
    expect(document.activeElement).toBe(title)
    fireEvent.change(title, { target: { value: '  Call the vet ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'p1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'ask about teeth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate).toHaveBeenCalledWith({
      title: 'Call the vet',
      dueAt: getDueBounds().tomorrow,
      projectId: 'p1',
      notes: 'ask about teeth',
    })
  })

  test('a share seeds the fields, shows the link, and sends it as sourceUrl', async () => {
    const { onCreate } = renderSheet({
      initial: { title: 'Great read', notes: 'worth a look', sourceUrl: 'https://example.com/post/1?x=2' },
    })
    expect(screen.getByRole('textbox', { name: 'New task name' }).value).toBe('Great read')
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('worth a look')
    const line = screen.getByText('Link: example.com/post/1')
    expect(line.getAttribute('title')).toBe('https://example.com/post/1?x=2')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      title: 'Great read', dueAt: null, notes: 'worth a look', sourceUrl: 'https://example.com/post/1?x=2',
    }))
  })

  test('without a share there is no link line and no sourceUrl key', async () => {
    const { onCreate } = renderSheet()
    expect(screen.queryByText(/^Link:/)).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Plain' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect('sourceUrl' in onCreate.mock.calls[0][0]).toBe(false)
  })

  test('Enter in the title submits, and No date is the default', async () => {
    const { onCreate } = renderSheet()
    const title = screen.getByRole('textbox', { name: 'New task name' })
    fireEvent.change(title, { target: { value: 'Quick one' } })
    expect(screen.getByRole('button', { name: 'No date' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.submit(title.closest('form'))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ title: 'Quick one', dueAt: null }))
  })

  test('the date field picks any other day and unpresses the chips', () => {
    renderSheet()
    fireEvent.change(screen.getByLabelText('Other date'), { target: { value: '2030-01-02' } })
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'No date' }).getAttribute('aria-pressed')).toBe('false')
  })

  test('Create stays disabled until there is a title', () => {
    renderSheet()
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(false)
  })

  test('a create that resolves closes the sheet', async () => {
    const { onClose } = renderSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  test('a create that resolves after the sheet was closed and reopened leaves the new draft open', async () => {
    let resolveFirst
    const onCreate = vi.fn().mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
    const onClose = vi.fn()
    const { rerender } = render(<NewTaskSheet open onClose={onClose} onCreate={onCreate} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Task A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    rerender(<NewTaskSheet open={false} onClose={onClose} onCreate={onCreate} />)
    rerender(<NewTaskSheet open onClose={onClose} onCreate={onCreate} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Task B' } })
    await act(async () => {
      resolveFirst()
      await Promise.resolve()
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'New task name' }).value).toBe('Task B')
  })

  test('a create that rejects after the sheet was closed and reopened leaves the new form alone', async () => {
    let rejectFirst
    const onCreate = vi.fn()
      .mockReturnValueOnce(new Promise((resolve, reject) => { rejectFirst = reject }))
      .mockReturnValueOnce(new Promise(() => {}))
    const onClose = vi.fn()
    const { rerender } = render(<NewTaskSheet open onClose={onClose} onCreate={onCreate} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Task A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    rerender(<NewTaskSheet open={false} onClose={onClose} onCreate={onCreate} />)
    rerender(<NewTaskSheet open onClose={onClose} onCreate={onCreate} />)
    // Task B is itself being saved when A's request fails.
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Task B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('textbox', { name: 'New task name' }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      rejectFirst(new Error('Server away'))
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'New task name' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
  })

  test('a failed create shows the error and lets the form be tried again', async () => {
    const { onCreate } = renderSheet()
    onCreate.mockRejectedValueOnce(new Error('Server away'))
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Server away'))
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(false)
  })

  test('Esc, Cancel, and the backdrop close it', () => {
    const { onClose, container } = renderSheet()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(container.querySelector('.sheet-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  test('closing returns focus to the button that opened it', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    const openButtonRef = { current: button }
    const { rerender } = render(<NewTaskSheet open onClose={() => {}} onCreate={() => {}} openButtonRef={openButtonRef} />)
    rerender(<NewTaskSheet open={false} onClose={() => {}} onCreate={() => {}} openButtonRef={openButtonRef} />)
    expect(document.activeElement).toBe(button)
    button.remove()
  })
})
