import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import UndoToast, { TOAST_MS } from './UndoToast'
import { dismissMoved, resetUndoToast, showCompleted, showMoved } from './command-center/undoToast'

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

  // A repeat counted from completion can come back the same day the done one was due, so the
  // toast says when the next one is due; a plain task, or one queued offline, has no date to name.
  test('a repeating task says when its next one is due', () => {
    render(<UndoToast />)
    const region = screen.getByRole('status')
    act(() => showCompleted('Brush teeth', () => {}, { nextDue: '2026-11-15' }))
    expect(region.textContent).toContain('Completed Brush teeth. The next one is due Sun, Nov 15.')
    act(() => showCompleted('Pay rent', () => {}))
    expect(region.textContent).not.toContain('next one')
  })

  test('Undo runs the callback once and removes the toast', () => {
    const undo = vi.fn()
    render(<UndoToast />)
    act(() => showCompleted('Pay rent', undo))
    fireEvent.click(screen.getByRole('button', { name: 'Undo completing Pay rent' }))
    expect(undo).toHaveBeenCalledTimes(1)
    expect(toast()).toBeNull()
  })

  test('a failed Undo says so with no timer, Retry runs it again, and success clears it', async () => {
    const undo = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce()
    render(<UndoToast />)
    act(() => showCompleted('Pay rent', undo))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo completing Pay rent' })) })
    expect(screen.getByRole('status').textContent).toContain('Could not reopen Pay rent')
    act(() => { vi.advanceTimersByTime(TOAST_MS * 3) })
    const retry = screen.getByRole('button', { name: 'Retry reopening Pay rent' })
    await act(async () => { fireEvent.click(retry) })
    expect(undo).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toBe('')
  })

  describe('a reopen that fails after another task was completed', () => {
    function deferred() {
      let reject
      const promise = new Promise((_resolve, rej) => { reject = rej })
      return { promise, reject }
    }
    const later = (name) => screen.getByRole('button', { name: `Undo completing ${name}` })

    test('a failed Undo leaves the newer toast and its Undo, each on its own terms', async () => {
      const first = deferred()
      const newer = vi.fn()
      render(<UndoToast />)
      act(() => showCompleted('Task A', () => first.promise))
      fireEvent.click(later('Task A'))
      act(() => showCompleted('Task B', newer))
      await act(async () => { first.reject(new Error('down')) })

      expect(screen.getByRole('status').textContent).toContain('Could not reopen Task A')
      expect(later('Task B')).toBeTruthy()
      // The newer toast still runs out, and the failure stays until the owner chooses.
      act(() => { vi.advanceTimersByTime(TOAST_MS + 100) })
      expect(screen.queryByRole('button', { name: 'Undo completing Task B' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Retry reopening Task A' })).toBeTruthy()
    })

    test('a failed Retry leaves the newer toast too', async () => {
      const retried = deferred()
      const undo = vi.fn().mockRejectedValueOnce(new Error('down')).mockReturnValueOnce(retried.promise)
      const newer = vi.fn()
      render(<UndoToast />)
      act(() => showCompleted('Task A', undo))
      await act(async () => { fireEvent.click(later('Task A')) })
      fireEvent.click(screen.getByRole('button', { name: 'Retry reopening Task A' }))
      act(() => showCompleted('Task B', newer))
      await act(async () => { retried.reject(new Error('down')) })

      fireEvent.click(later('Task B'))
      expect(newer).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Retry reopening Task A' })).toBeTruthy()
    })

    test('the failure shows above the newer toast, which does not move', async () => {
      const first = deferred()
      render(<UndoToast />)
      act(() => showCompleted('Task A', () => first.promise))
      fireEvent.click(later('Task A'))
      act(() => showCompleted('Task B', () => {}))
      await act(async () => { first.reject(new Error('down')) })
      const retry = screen.getByRole('button', { name: 'Retry reopening Task A' })
      expect(retry.compareDocumentPosition(later('Task B')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    test('two failures both stay', async () => {
      render(<UndoToast />)
      act(() => showCompleted('Task A', () => Promise.reject(new Error('down'))))
      await act(async () => { fireEvent.click(later('Task A')) })
      act(() => showCompleted('Task B', () => Promise.reject(new Error('down'))))
      await act(async () => { fireEvent.click(later('Task B')) })
      expect(screen.getByRole('button', { name: 'Retry reopening Task A' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Retry reopening Task B' })).toBeTruthy()
    })
  })

  test('a failed Undo can be dismissed', async () => {
    render(<UndoToast />)
    act(() => showCompleted('Pay rent', () => Promise.reject(new Error('down'))))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo completing Pay rent' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss, Pay rent stays completed' }))
    expect(screen.getByRole('status').textContent).toBe('')
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

describe('UndoToast for a move', () => {
  const moved = (over = {}) => showMoved({ title: 'Pay rent', where: 'Tomorrow', view: () => {}, undo: () => {}, ...over })

  test('says where the task went, politely, with View and Undo, and moves no focus', () => {
    render(<UndoToast />)
    act(() => moved())
    expect(screen.getByRole('status').textContent).toContain('Moved Pay rent to Tomorrow')
    expect(screen.getByRole('button', { name: 'View Pay rent in Tomorrow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Undo moving Pay rent to Tomorrow' })).toBeTruthy()
    expect(document.activeElement).toBe(document.body)
  })

  test('View runs the view callback once and removes the toast', () => {
    const view = vi.fn()
    render(<UndoToast />)
    act(() => moved({ view }))
    fireEvent.click(screen.getByRole('button', { name: 'View Pay rent in Tomorrow' }))
    expect(view).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /^View / })).toBeNull()
  })

  test('a failed Undo says it could not move the task back, with Retry and Dismiss', async () => {
    const undo = vi.fn().mockRejectedValueOnce(new Error('down'))
    render(<UndoToast />)
    act(() => moved({ undo }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo moving Pay rent to Tomorrow' })) })
    expect(screen.getByRole('status').textContent).toContain('Could not move back Pay rent')
    expect(screen.getByRole('button', { name: 'Retry moving Pay rent back' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss, Pay rent stays in Tomorrow' })).toBeTruthy()
  })

  test('the tab going clears its move toast but keeps a failure and a completion', async () => {
    render(<UndoToast />)
    act(() => moved({ title: 'A', undo: vi.fn().mockRejectedValueOnce(new Error('down')) }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo moving A to Tomorrow' })) })
    act(() => moved({ title: 'B' }))
    act(() => dismissMoved())
    expect(screen.queryByRole('button', { name: 'View B in Tomorrow' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry moving A back' })).toBeTruthy()
    act(() => showCompleted('C', () => {}))
    act(() => dismissMoved())
    expect(screen.getByRole('button', { name: 'Undo completing C' })).toBeTruthy()
  })
})
