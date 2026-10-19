import { describe, test, expect, vi, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NewTaskSheet from './NewTaskSheet'
import { getDueBounds } from './dueDates'
import { weekdayOf } from './recurrenceRules'

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

  test('Pick a date opens the calendar, and a day picked there is shown and unpresses the chips', () => {
    renderSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Dentist' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pick a date' }))
    expect(screen.getByRole('heading', { name: 'When is it due?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    const day = screen.getAllByRole('button').find((b) => b.dataset.date?.endsWith('-15'))
    fireEvent.click(day)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'No date' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Pick a date' })).toBeNull()
  })

  test('a time added in the date step is shown on the form, kept by a quick date, and sent', async () => {
    const { onCreate } = renderSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Dentist' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pick a date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    const { tomorrow } = getDueBounds()
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /2:30\sPM$/ })).toBeTruthy()
    // Reopening the date step starts on the time already chosen.
    fireEvent.click(screen.getByRole('button', { name: /2:30\sPM$/ }))
    expect(screen.getByLabelText('Time').value).toBe('14:30')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ title: 'Dentist', dueAt: `${tomorrow}T14:30` }))
  })

  test('Esc in the date step goes back to the form and keeps the sheet open', () => {
    const { onClose } = renderSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Walk' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'New task name' }), { key: 'Enter' })
    expect(screen.getByRole('heading', { name: 'When is it due?' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'New task name' }).value).toBe('Walk')
  })

  test('a repeat chosen on the form is sent with the task', async () => {
    const { onCreate } = renderSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Bins out' } })
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ title: 'Bins out', dueAt: getDueBounds().today, recurrence: `FREQ=WEEKLY;BYDAY=${weekdayOf(getDueBounds().today)}` }))
  })

  // Today, then Custom (today's weekday pressed), then Tomorrow: the rule keeps today's weekday
  // rather than a plain weekly that would follow the new date (review on #66).
  test('a custom weekday stays when the due date changes after it', async () => {
    const { onCreate } = renderSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Laundry' } })
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'custom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(onCreate.mock.calls[0][0]).toMatchObject({ dueAt: getDueBounds().tomorrow, recurrence: `FREQ=WEEKLY;BYDAY=${weekdayOf(getDueBounds().today)}` })
  })

  test('a plain Weekly follows a quick date picked after it', async () => {
    const { onCreate } = renderSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Bins out' } })
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(onCreate.mock.calls[0][0]).toMatchObject({ dueAt: getDueBounds().tomorrow, recurrence: `FREQ=WEEKLY;BYDAY=${weekdayOf(getDueBounds().tomorrow)}` })
  })

  test('Custom repeat opens the builder, and the weekdays tapped there make the rule', async () => {
    const { onCreate } = renderSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'New task name' }), { target: { value: 'Gym' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'custom' } })
    for (const name of ['Monday', 'Wednesday', 'Friday']) {
      const day = screen.getByRole('button', { name })
      if (day.getAttribute('aria-pressed') !== 'true') fireEvent.click(day)
    }
    for (const name of ['Tuesday', 'Thursday', 'Saturday', 'Sunday']) {
      const day = screen.getByRole('button', { name })
      if (day.getAttribute('aria-pressed') === 'true') fireEvent.click(day)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(onCreate.mock.calls[0][0].recurrence).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR')
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

// The title box grows with its text so a long title is seen whole while it is typed (CONTRIBUTING.md,
// "Nothing is cut off"), and Enter goes on to the due date, where Enter again keeps the one picked.
describe('NewTaskSheet title box', () => {
  test('is a textarea, and Enter goes on to the due date, then the day, Done, and Create add the task', async () => {
    const { onCreate } = renderSheet()
    const title = screen.getByRole('textbox', { name: 'New task name' })
    expect(title.tagName).toBe('TEXTAREA')
    fireEvent.change(title, { target: { value: 'Book the van service' } })
    fireEvent.keyDown(title, { key: 'Enter' })
    expect(screen.getByRole('heading', { name: 'When is it due?' })).toBeTruthy()
    expect(document.activeElement.dataset.date).toBe(getDueBounds().today)
    fireEvent.click(document.activeElement)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(onCreate.mock.calls[0][0].dueAt).toBe(getDueBounds().today)
    expect(onCreate.mock.calls[0][0].title).toBe('Book the van service')
  })

  test('a pasted line break becomes a space', () => {
    renderSheet()
    const title = screen.getByRole('textbox', { name: 'New task name' })
    fireEvent.change(title, { target: { value: 'Book the van\nservice' } })
    expect(title.value).toBe('Book the van service')
  })
})
