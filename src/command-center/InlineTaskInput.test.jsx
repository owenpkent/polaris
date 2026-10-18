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
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: getDueBounds().tomorrow, recurrence: null })
  })

  test('a repeat chosen in the panel goes with the day', async () => {
    const { input, onSubmit } = setup()
    await openPicker(input)
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), { target: { value: 'daily' } })
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit).toHaveBeenCalledWith('Buy milk', { dueAt: getDueBounds().today, recurrence: 'daily' })
  })

  test('No date submits a null date', async () => {
    const { input, onSubmit } = setup()
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'No date' }))
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), { target: { value: 'custom' } })
    expect(screen.getByRole('button', { name: 'Wednesday' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(document.querySelector('[data-date="2026-10-16"]'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][1]).toEqual({ dueAt: '2026-10-16', recurrence: 'FREQ=WEEKLY;BYDAY=WE' })
  })

  test('a failed submit shows the error and keeps the title', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Nope'))
    const { input } = setup({ onSubmit })
    await openPicker(input)
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(await screen.findByText('Nope')).toBeTruthy()
    expect(input.value).toBe('Buy milk')
  })
})
