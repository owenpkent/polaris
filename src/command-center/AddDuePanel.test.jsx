import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import AddDuePanel from './AddDuePanel'
import { getDueBounds } from './dueDates'

afterEach(cleanup)

// Leaving the panel any way but Esc or the submit hands the picks to onLeave (CONTRIBUTING.md,
// "Leaving an edit"); the callers decide what to do with them.
describe('AddDuePanel leaving', () => {
  test('unmounting keeps the day, time, and repeat picked, without submitting', () => {
    const onPick = vi.fn()
    const onLeave = vi.fn()
    const { unmount } = render(<AddDuePanel dueAt={null} onPick={onPick} onLeave={onLeave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:30' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeats' }), { target: { value: 'daily' } })
    unmount()
    expect(onPick).not.toHaveBeenCalled()
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(onLeave).toHaveBeenCalledWith(`${getDueBounds().tomorrow}T14:30`, { recurrence: 'daily', customRepeat: false })
  })

  test('with nothing changed it hands back the date it was given', () => {
    const today = getDueBounds().today
    const onLeave = vi.fn()
    const { unmount } = render(<AddDuePanel dueAt={today} onPick={vi.fn()} onLeave={onLeave} />)
    unmount()
    expect(onLeave).toHaveBeenCalledWith(today, { recurrence: '', customRepeat: false })
  })

  test('No date leaves null', () => {
    const onLeave = vi.fn()
    const { unmount } = render(<AddDuePanel dueAt={getDueBounds().today} onPick={vi.fn()} onLeave={onLeave} />)
    fireEvent.click(screen.getByRole('button', { name: 'No date' }))
    unmount()
    expect(onLeave).toHaveBeenCalledWith(null, { recurrence: '', customRepeat: false })
  })

  test('Esc discards the picks', () => {
    const onLeave = vi.fn()
    const { unmount } = render(<AddDuePanel dueAt={null} onPick={vi.fn()} onLeave={onLeave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    unmount()
    expect(onLeave).not.toHaveBeenCalled()
  })

  test('a submit is not also a leave', () => {
    const onPick = vi.fn()
    const onLeave = vi.fn()
    const { unmount } = render(<AddDuePanel dueAt={null} onPick={onPick} onLeave={onLeave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    unmount()
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onLeave).not.toHaveBeenCalled()
  })
})
