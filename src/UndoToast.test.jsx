import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import UndoToast, { TOAST_MS } from './UndoToast'
import { resetUndoToast, showCompleted } from './command-center/undoToast'

beforeEach(() => {
  vi.useFakeTimers()
  resetUndoToast()
})

afterEach(() => {
  cleanup()
  resetUndoToast()
  vi.useRealTimers()
})

const toast = () => screen.queryByRole('button', { name: /^Undo completing/ })

describe('UndoToast', () => {
  test('announces the completion in a polite status region and moves no focus', () => {
    render(<UndoToast />)
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    act(() => showCompleted('Pay rent', () => {}))
    expect(region.textContent).toContain('Completed Pay rent')
    expect(document.activeElement).toBe(document.body)
  })

  test('Undo runs the callback once and removes the toast', () => {
    const undo = vi.fn()
    render(<UndoToast />)
    act(() => showCompleted('Pay rent', undo))
    fireEvent.click(screen.getByRole('button', { name: 'Undo completing Pay rent' }))
    expect(undo).toHaveBeenCalledTimes(1)
    expect(toast()).toBeNull()
  })

  test('goes away after about six seconds', () => {
    render(<UndoToast />)
    act(() => showCompleted('Pay rent', () => {}))
    act(() => { vi.advanceTimersByTime(TOAST_MS - 100) })
    expect(toast()).not.toBeNull()
    act(() => { vi.advanceTimersByTime(200) })
    expect(toast()).toBeNull()
  })

  test('waits while the pointer is over it, then runs the full time again', () => {
    render(<UndoToast />)
    act(() => showCompleted('Pay rent', () => {}))
    const button = toast()
    fireEvent.mouseEnter(button.parentElement)
    act(() => { vi.advanceTimersByTime(TOAST_MS * 3) })
    expect(toast()).not.toBeNull()
    fireEvent.mouseLeave(button.parentElement)
    act(() => { vi.advanceTimersByTime(TOAST_MS - 100) })
    expect(toast()).not.toBeNull()
    act(() => { vi.advanceTimersByTime(200) })
    expect(toast()).toBeNull()
  })

  test('waits while focus is inside it', () => {
    render(<UndoToast />)
    act(() => showCompleted('Pay rent', () => {}))
    act(() => toast().focus())
    act(() => { vi.advanceTimersByTime(TOAST_MS * 3) })
    expect(toast()).not.toBeNull()
  })

  test('a new completion replaces the toast and restarts the time', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(<UndoToast />)
    act(() => showCompleted('One', first))
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1000) })
    act(() => showCompleted('Two', second))
    expect(screen.queryByRole('button', { name: 'Undo completing One' })).toBeNull()
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1000) })
    fireEvent.click(screen.getByRole('button', { name: 'Undo completing Two' }))
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  test('Esc dismisses it when focus is in it', () => {
    render(<UndoToast />)
    act(() => showCompleted('Pay rent', () => {}))
    fireEvent.keyDown(toast(), { key: 'Escape' })
    expect(toast()).toBeNull()
  })

  test('a title is shown as text, never as markup', () => {
    render(<UndoToast />)
    act(() => showCompleted('<img src=x onerror=alert(1)>', () => {}))
    expect(document.querySelector('.undo-toast img')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
