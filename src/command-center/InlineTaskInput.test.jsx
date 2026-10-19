import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import InlineTaskInput from './InlineTaskInput'
import { getDueBounds } from './dueDates'

afterEach(cleanup)

function setup(props = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  const onCancel = vi.fn()
  render(<InlineTaskInput onSubmit={onSubmit} onCancel={onCancel} gridTemplateColumns="1fr 1fr" {...props} />)
  return { onSubmit, onCancel, input: screen.getByRole('textbox', { name: 'New task name' }) }
}

async function openPicker(input, title = 'Buy milk') {
  fireEvent.change(input, { target: { value: title } })
  fireEvent.keyDown(input, { key: 'Enter' })
  return screen.findByRole('dialog', { name: `Due date for ${title}` })
}

describe('InlineTaskInput', () => {
  test('Enter with an empty title does nothing', () => {
    const { input, onSubmit } = setup()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('Enter with a title opens the due date dialog', async () => {
    const { input } = setup()
    const dialog = await openPicker(input)
    expect(dialog.parentElement.closest('body')).toBe(document.body)
    expect(screen.getByRole('heading', { name: 'When is it due?' })).toBeTruthy()
  })

  test('Tomorrow submits the title with tomorrow and no recurrence', async () => {
    const { input, onSubmit } = setup()
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: getDueBounds().tomorrow, recurrence: null })
  })

  test('a repeat chosen in the panel goes with the day', async () => {
    const { input, onSubmit } = setup()
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'daily' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: getDueBounds().today, recurrence: 'daily' })
  })

  test('Add time opens a time box, and the day picked next carries the time', async () => {
    const { input, onSubmit } = setup()
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    const time = screen.getByLabelText('Time')
    expect(document.activeElement).toBe(time)
    fireEvent.change(time, { target: { value: '09:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: `${getDueBounds().tomorrow}T09:30`, recurrence: null }))
  })

  test('Enter in the time box keeps the group date', async () => {
    const today = getDueBounds().today
    const { input, onSubmit } = setup({ defaultDueAt: today })
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    const time = screen.getByLabelText('Time')
    fireEvent.change(time, { target: { value: '18:00' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: `${today}T18:00`, recurrence: null }))
  })

  test('a half-typed time keeps the last whole one for the pick', async () => {
    const { input, onSubmit } = setup()
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    const time = screen.getByLabelText('Time')
    fireEvent.change(time, { target: { value: '09:30' } })
    Object.defineProperty(time, 'validity', { configurable: true, value: { badInput: true, valid: false } })
    fireEvent.change(time, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: `${getDueBounds().today}T09:30`, recurrence: null }))
  })

  test('Remove time drops the time again and puts focus back on Add time', async () => {
    const { input, onSubmit } = setup()
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove time' }))
    expect(screen.queryByLabelText('Time')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add time' }))
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: getDueBounds().today, recurrence: null }))
  })

  test('No date submits a null date', async () => {
    const { input, onSubmit } = setup()
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'No date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: null, recurrence: null }))
  })

  test('Escape closes the popover, keeps the title, and calls nothing', async () => {
    const { input, onSubmit, onCancel } = setup()
    await openPicker(input)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(input.value).toBe('Buy milk')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  test('Escape in the title cancels', () => {
    const { input, onCancel } = setup()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  test('defaultDueAt is the pressed day', async () => {
    const { input } = setup({ defaultDueAt: '2026-10-14' })
    await openPicker(input)
    const day = document.querySelector('[data-date="2026-10-14"]')
    expect(day.getAttribute('aria-pressed')).toBe('true')
  })

  // A weekday picked in Custom stays that weekday when the first due date is another day: the rule
  // names it, rather than a plain weekly that would follow the date (review on #66).
  test('a custom weekday stays when a different first day is picked', async () => {
    const { input, onSubmit } = setup({ defaultDueAt: '2026-10-14' })
    await openPicker(input)
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'custom' } })
    expect(screen.getByRole('button', { name: 'Wednesday' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(document.querySelector('[data-date="2026-10-16"]'))
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][1]).toEqual({ dueAt: '2026-10-16', recurrence: 'FREQ=WEEKLY;BYDAY=WE' })
  })

  test('a failed submit shows the error and keeps the title', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Nope'))
    const { input } = setup({ onSubmit })
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    expect(await screen.findByText('Nope')).toBeTruthy()
    expect(input.value).toBe('Buy milk')
  })

  test('a tap on a day selects it, and a second tap on it adds the task', async () => {
    const { input, onSubmit } = setup({ defaultDueAt: '2026-10-14' })
    await openPicker(input)
    const day = document.querySelector('[data-date="2026-10-16"]')
    fireEvent.click(day)
    expect(day.getAttribute('aria-pressed')).toBe('true')
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(day)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: '2026-10-16', recurrence: null }))
  })

  // Enter in the title, then Enter on the day the calendar focuses, keeps the group's date.
  test("a second pick of the group's date adds the task", async () => {
    const { input, onSubmit } = setup({ defaultDueAt: '2026-10-14' })
    await openPicker(input)
    fireEvent.click(document.querySelector('[data-date="2026-10-14"]'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: '2026-10-14', recurrence: null }))
  })

  test('Weekly follows the day picked after it, and the next dates are tinted on the month', async () => {
    const api = { previewRecurrence: vi.fn().mockResolvedValue({ dates: ['2026-10-23', '2026-10-30', '2026-11-06'] }) }
    const { input, onSubmit } = setup({ defaultDueAt: '2026-10-14', api })
    await openPicker(input)
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'weekly' } })
    fireEvent.click(document.querySelector('[data-date="2026-10-16"]'))
    expect(screen.getByRole('button', { name: 'Friday' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(document.querySelector('[data-date="2026-10-23"]').hasAttribute('data-repeat')).toBe(true))
    expect(document.querySelector('[data-date="2026-10-23"]').getAttribute('aria-label')).toMatch(/, repeats$/)
    expect(api.previewRecurrence).toHaveBeenLastCalledWith('FREQ=WEEKLY;BYDAY=FR', '2026-10-16', 3)
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: '2026-10-16', recurrence: 'FREQ=WEEKLY;BYDAY=FR' }))
  })

  test('the due date button beside the name opens the picker once there is a name', async () => {
    const { input } = setup({ defaultDueAt: getDueBounds().today })
    const due = screen.getByRole('button', { name: 'Due date: Today' })
    expect(due.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Buy milk' } })
    fireEvent.click(due)
    expect(await screen.findByRole('dialog', { name: 'Due date for Buy milk' })).toBeTruthy()
  })
})
