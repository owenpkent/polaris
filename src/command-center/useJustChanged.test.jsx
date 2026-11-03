import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import TaskRow from './TaskRow'
import { getDueBounds } from './dueDates'
import { JUST_CHANGED_MS, clearChanged, markChanged, useJustChanged } from './useJustChanged'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  clearChanged()
  cleanup()
  vi.useRealTimers()
})

describe('useJustChanged', () => {
  test('is true after markChanged and false again after the highlight time', () => {
    const { result } = renderHook(() => useJustChanged('t1'))
    expect(result.current.changed).toBe(false)
    act(() => markChanged('t1'))
    expect(result.current.changed).toBe(true)
    act(() => { vi.advanceTimersByTime(JUST_CHANGED_MS - 1) })
    expect(result.current.changed).toBe(true)
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.changed).toBe(false)
  })

  test('marks only the task named, and ignores an empty id', () => {
    const { result } = renderHook(() => useJustChanged('t2'))
    act(() => { markChanged('t1'); markChanged(undefined) })
    expect(result.current.changed).toBe(false)
  })

  test('a second mark restarts the time', () => {
    const { result } = renderHook(() => useJustChanged('t1'))
    act(() => markChanged('t1'))
    act(() => { vi.advanceTimersByTime(800) })
    act(() => markChanged('t1'))
    act(() => { vi.advanceTimersByTime(800) })
    expect(result.current.changed).toBe(true)
    act(() => { vi.advanceTimersByTime(400) })
    expect(result.current.changed).toBe(false)
  })

  test('a row that mounts after the mark is highlighted, and scrolls only when out of view', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    function Probe({ id }) {
      const { changed, ref } = useJustChanged(id)
      return <div ref={ref} className={changed ? 'just-changed' : ''} data-testid="probe" />
    }
    act(() => markChanged('t1'))
    // jsdom lays nothing out: a zero rect is inside the viewport, so no scroll.
    render(<Probe id="t1" />)
    expect(screen.getByTestId('probe').className).toBe('just-changed')
    expect(scroll).not.toHaveBeenCalled()
    cleanup()

    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 5000, bottom: 5040 })
    render(<Probe id="t1" />)
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' })
    spy.mockRestore()
    delete Element.prototype.scrollIntoView
  })
})

describe('TaskRow highlight', () => {
  test('the row gets the class when its task is marked and loses it after the time', () => {
    const { container } = render(
      <TaskRow
        task={{ id: 't1', title: 'Write the report', status: 'open', priority: 'high', dueAt: null, projectId: null }}
        projectOptions={[]}
        dueBounds={getDueBounds(new Date('2026-09-29T12:00:00'))}
        visibleColumns={[{ id: 'due' }]}
        gridTemplateColumns="44px 1fr 100px"
        phone={false}
        onToggleComplete={() => {}}
        onOpen={() => {}}
        onQuickUpdate={() => {}}
      />
    )
    const row = container.querySelector('.mytasks-row')
    expect(row.className).not.toContain('just-changed')
    act(() => markChanged('t1'))
    expect(row.className).toContain('just-changed')
    act(() => { vi.advanceTimersByTime(JUST_CHANGED_MS) })
    expect(row.className).not.toContain('just-changed')
  })
})
