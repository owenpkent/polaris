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

    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 5000, bottom: 5040, left: 0, right: 100 })
    render(<Probe id="t1" />)
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    spy.mockRestore()
    delete Element.prototype.scrollIntoView
  })

  describe('a card in a lane off to the side', () => {
    const CARD = { top: 10, bottom: 50 }
    function Probe() {
      const { ref } = useJustChanged('t1')
      return <div style={{ overflowX: 'auto' }} data-testid="lanes"><div ref={ref} data-testid="card" /></div>
    }
    function layout(card, lanes) {
      return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
        if (this.dataset.testid === 'card') return { ...CARD, ...card }
        if (this.dataset.testid === 'lanes') return { top: 0, bottom: 700, ...lanes }
        return { top: 0, bottom: 0, left: 0, right: 0 }
      })
    }
    let scroll
    beforeEach(() => {
      scroll = vi.fn()
      Element.prototype.scrollIntoView = scroll
      act(() => markChanged('t1'))
    })
    afterEach(() => {
      vi.restoreAllMocks()
      delete Element.prototype.scrollIntoView
      delete window.matchMedia
    })

    test('scrolls when it is past the side of the viewport, though its height fits', () => {
      layout({ left: window.innerWidth + 100, right: window.innerWidth + 300 }, { left: 0, right: window.innerWidth + 300 })
      render(<Probe />)
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    })

    test('scrolls when the lanes clip it, though it is inside the viewport', () => {
      layout({ left: 310, right: 500 }, { left: 0, right: 300 })
      render(<Probe />)
      expect(scroll).toHaveBeenCalledTimes(1)
    })

    test('jumps instead of gliding under reduced motion', () => {
      window.matchMedia = vi.fn(() => ({ matches: true }))
      layout({ left: 310, right: 500 }, { left: 0, right: 300 })
      render(<Probe />)
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'auto' })
    })

    test('stays put when the lanes show all of it', () => {
      layout({ left: 10, right: 200 }, { left: 0, right: 300 })
      render(<Probe />)
      expect(scroll).not.toHaveBeenCalled()
    })
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
