import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  COLUMN_DEFS,
  useColumnsState,
  useNarrowBreakpoints,
  getVisibleColumns,
  buildGridTemplate,
  BREAKPOINT_QUERIES,
} from './columnsState'
import { SORT_FIELDS } from './viewState'

const Q = BREAKPOINT_QUERIES

const COLUMNS_STORAGE_KEY = 'cc-mytasks-columns-v1'

beforeEach(() => {
  localStorage.clear()
})

describe('COLUMN_DEFS', () => {
  test('lists the five My Tasks columns in a fixed order', () => {
    expect(COLUMN_DEFS.map((c) => c.id)).toEqual(['name', 'due', 'project', 'priority', 'source'])
  })

  test('has unique ids', () => {
    const ids = COLUMN_DEFS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('name is the only column that cannot be hidden', () => {
    for (const col of COLUMN_DEFS) {
      expect(col.canHide).toBe(col.id !== 'name')
    }
  })

  test('every column defaultWidth is at least its own minWidth', () => {
    for (const col of COLUMN_DEFS) {
      expect(col.defaultWidth).toBeGreaterThanOrEqual(col.minWidth)
    }
  })

  test('every non-null sortField lines up with a real SORT_FIELDS id', () => {
    const sortFieldIds = new Set(SORT_FIELDS.map((f) => f.id))
    for (const col of COLUMN_DEFS) {
      if (col.sortField !== null) expect(sortFieldIds.has(col.sortField)).toBe(true)
    }
  })

  test('the source column is not sortable', () => {
    expect(COLUMN_DEFS.find((c) => c.id === 'source').sortField).toBeNull()
  })
})

describe('getVisibleColumns', () => {
  const noHidden = { name: false, due: false, project: false, priority: false, source: false }

  test('shows every column when nothing is hidden and no breakpoint is active', () => {
    const visible = getVisibleColumns(noHidden, { narrow900: false, narrow600: false, phone: false, panelOpen: false })
    expect(visible.map((c) => c.id)).toEqual(['name', 'due', 'project', 'priority', 'source'])
  })

  test('respects an explicit per-column hidden flag', () => {
    const hidden = { ...noHidden, priority: true }
    const visible = getVisibleColumns(hidden, { narrow900: false, narrow600: false, phone: false, panelOpen: false })
    expect(visible.map((c) => c.id)).toEqual(['name', 'due', 'project', 'source'])
  })

  test('never hides the name column even if asked to', () => {
    const hidden = { ...noHidden, name: true }
    const visible = getVisibleColumns(hidden, { narrow900: false, narrow600: false, phone: false, panelOpen: false })
    expect(visible.map((c) => c.id)).toContain('name')
  })

  test('narrow900 hides priority and source even when the user left them visible', () => {
    const visible = getVisibleColumns(noHidden, { narrow900: true, narrow600: false, phone: false, panelOpen: false })
    expect(visible.map((c) => c.id)).toEqual(['name', 'due', 'project'])
  })

  test('an open detail panel hides priority and source the same way narrow900 does', () => {
    const visible = getVisibleColumns(noHidden, { narrow900: false, narrow600: false, phone: false, panelOpen: true })
    expect(visible.map((c) => c.id)).toEqual(['name', 'due', 'project'])
  })

  test('narrow600 hides the project column independently of narrow900', () => {
    const visible = getVisibleColumns(noHidden, { narrow900: false, narrow600: true, phone: false, panelOpen: false })
    expect(visible.map((c) => c.id)).toEqual(['name', 'due', 'priority', 'source'])
  })

  test('narrow900 and narrow600 combined hide project, priority, and source', () => {
    const visible = getVisibleColumns(noHidden, { narrow900: true, narrow600: true, phone: false, panelOpen: false })
    expect(visible.map((c) => c.id)).toEqual(['name', 'due'])
  })

  test('phone tier fixes the column set to name and due only', () => {
    const visible = getVisibleColumns(noHidden, { narrow900: false, narrow600: false, phone: true, panelOpen: false })
    expect(visible.map((c) => c.id)).toEqual(['name', 'due'])
  })

  test('phone tier keeps due visible even if the user hid it, ignoring saved hidden state', () => {
    const hidden = { ...noHidden, due: true, priority: true, project: true, source: true }
    const visible = getVisibleColumns(hidden, { narrow900: false, narrow600: false, phone: true, panelOpen: false })
    expect(visible.map((c) => c.id)).toEqual(['name', 'due'])
  })

  test('phone tier overrides narrow900/narrow600/panelOpen all being active too', () => {
    const visible = getVisibleColumns(noHidden, { narrow900: true, narrow600: true, phone: true, panelOpen: true })
    expect(visible.map((c) => c.id)).toEqual(['name', 'due'])
  })
})

describe('buildGridTemplate', () => {
  const widths = { name: 440, due: 130, project: 180, priority: 100, source: 120 }

  test('builds the full template with a leading checkbox track and trailing filler', () => {
    const template = buildGridTemplate(COLUMN_DEFS, widths, {})
    expect(template).toBe(
      '44px minmax(160px, 440px) minmax(90px, 130px) minmax(90px, 180px) minmax(80px, 100px) minmax(80px, 120px) minmax(0, 1fr)'
    )
  })

  test('only emits tracks for the columns actually passed in', () => {
    const nameCol = COLUMN_DEFS.find((c) => c.id === 'name')
    const dueCol = COLUMN_DEFS.find((c) => c.id === 'due')
    const template = buildGridTemplate([nameCol, dueCol], widths, {})
    expect(template).toBe('44px minmax(160px, 440px) minmax(90px, 130px) minmax(0, 1fr)')
  })

  test('falls back to a column defaultWidth when widths omits it', () => {
    const nameCol = COLUMN_DEFS.find((c) => c.id === 'name')
    const template = buildGridTemplate([nameCol], {}, {})
    expect(template).toBe(`44px minmax(160px, ${nameCol.defaultWidth}px) minmax(0, 1fr)`)
  })

  test('returns the fixed phone template regardless of columns or widths', () => {
    const template = buildGridTemplate(COLUMN_DEFS, widths, { phone: true })
    expect(template).toBe('44px minmax(0, 1fr) 112px')
  })

  test('treats a missing options argument as non-phone', () => {
    const nameCol = COLUMN_DEFS.find((c) => c.id === 'name')
    const template = buildGridTemplate([nameCol], widths)
    expect(template).toBe('44px minmax(160px, 440px) minmax(0, 1fr)')
  })
})

describe('useColumnsState', () => {
  test('defaults every column to its defaultWidth and visible state', () => {
    const { result } = renderHook(() => useColumnsState())
    for (const col of COLUMN_DEFS) {
      expect(result.current.widths[col.id]).toBe(col.defaultWidth)
      expect(result.current.hidden[col.id]).toBe(false)
    }
  })

  test('merges a partial persisted state over the defaults', () => {
    localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify({ widths: { due: 200 }, hidden: { priority: true } }))
    const { result } = renderHook(() => useColumnsState())
    expect(result.current.widths.due).toBe(200)
    expect(result.current.widths.name).toBe(440)
    expect(result.current.hidden.priority).toBe(true)
    expect(result.current.hidden.source).toBe(false)
  })

  test('falls back to defaults when localStorage holds corrupted JSON', () => {
    localStorage.setItem(COLUMNS_STORAGE_KEY, '{not valid json')
    const { result } = renderHook(() => useColumnsState())
    expect(result.current.widths.name).toBe(440)
  })

  test('falls back to defaults when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const { result } = renderHook(() => useColumnsState())
    expect(result.current.widths.name).toBe(440)
    spy.mockRestore()
  })

  test('setWidth clamps below the column minimum', () => {
    const { result } = renderHook(() => useColumnsState())
    act(() => {
      result.current.setWidth('name', 10)
    })
    expect(result.current.widths.name).toBe(160)
  })

  test('setWidth clamps above the shared max width', () => {
    const { result } = renderHook(() => useColumnsState())
    act(() => {
      result.current.setWidth('name', 5000)
    })
    expect(result.current.widths.name).toBe(1200)
  })

  test('setWidth accepts an in-range value unchanged', () => {
    const { result } = renderHook(() => useColumnsState())
    act(() => {
      result.current.setWidth('due', 150)
    })
    expect(result.current.widths.due).toBe(150)
  })

  test('setWidth is a no-op for an unknown column id', () => {
    const { result } = renderHook(() => useColumnsState())
    const before = result.current.widths
    act(() => {
      result.current.setWidth('bogus', 500)
    })
    expect(result.current.widths).toEqual(before)
  })

  test('resetWidth restores a column back to its defaultWidth', () => {
    const { result } = renderHook(() => useColumnsState())
    act(() => {
      result.current.setWidth('due', 999)
    })
    act(() => {
      result.current.resetWidth('due')
    })
    expect(result.current.widths.due).toBe(130)
  })

  test('setHidden toggles a hideable column', () => {
    const { result } = renderHook(() => useColumnsState())
    act(() => {
      result.current.setHidden('priority', true)
    })
    expect(result.current.hidden.priority).toBe(true)
  })

  test('setHidden refuses to hide the name column', () => {
    const { result } = renderHook(() => useColumnsState())
    act(() => {
      result.current.setHidden('name', true)
    })
    expect(result.current.hidden.name).toBe(false)
  })

  test('persists a width change to localStorage', () => {
    const { result } = renderHook(() => useColumnsState())
    act(() => {
      result.current.setWidth('due', 175)
    })
    const saved = JSON.parse(localStorage.getItem(COLUMNS_STORAGE_KEY))
    expect(saved.widths.due).toBe(175)
  })

  test('still updates in-memory state when localStorage.setItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const { result } = renderHook(() => useColumnsState())
    act(() => {
      result.current.setHidden('source', true)
    })
    expect(result.current.hidden.source).toBe(true)
    spy.mockRestore()
  })
})

describe('useNarrowBreakpoints', () => {
  // jsdom does not implement window.matchMedia, so every test here stubs it
  // with fake MediaQueryList objects whose `matches` and listener registry
  // we control directly.
  function stubMatchMedia(matchesByQuery) {
    const listeners = new Map()
    const objects = new Map()
    window.matchMedia = vi.fn((query) => {
      if (!objects.has(query)) {
        listeners.set(query, [])
        objects.set(query, {
          get matches() {
            return !!matchesByQuery[query]
          },
          media: query,
          addEventListener: (event, cb) => listeners.get(query).push(cb),
          removeEventListener: (event, cb) => {
            const arr = listeners.get(query)
            const idx = arr.indexOf(cb)
            if (idx !== -1) arr.splice(idx, 1)
          },
        })
      }
      return objects.get(query)
    })
    return {
      fire(query) {
        for (const cb of listeners.get(query) || []) cb()
      },
      listenerCount(query) {
        return (listeners.get(query) || []).length
      },
    }
  }

  afterEach(() => {
    delete window.matchMedia
  })

  test('reports all breakpoints inactive on a wide viewport', () => {
    stubMatchMedia({
      [Q.narrow900]: false,
      [Q.narrow600]: false,
      [Q.phone]: false,
    })
    const { result } = renderHook(() => useNarrowBreakpoints())
    expect(result.current).toEqual({ narrow900: false, narrow600: false, phone: false, narrowPanel: false })
  })

  test('reports narrow900 alone at a mid-size viewport', () => {
    stubMatchMedia({
      [Q.narrow900]: true,
      [Q.narrow600]: false,
      [Q.phone]: false,
    })
    const { result } = renderHook(() => useNarrowBreakpoints())
    expect(result.current).toEqual({ narrow900: true, narrow600: false, phone: false, narrowPanel: false })
  })

  test('reports narrow900 and narrow600 together, but not phone, just above the phone breakpoint', () => {
    stubMatchMedia({
      [Q.narrow900]: true,
      [Q.narrow600]: true,
      [Q.phone]: false,
    })
    const { result } = renderHook(() => useNarrowBreakpoints())
    expect(result.current).toEqual({ narrow900: true, narrow600: true, phone: false, narrowPanel: false })
  })

  test('reports all three breakpoints active on a phone-size viewport', () => {
    stubMatchMedia({
      [Q.narrow900]: true,
      [Q.narrow600]: true,
      [Q.phone]: true,
    })
    const { result } = renderHook(() => useNarrowBreakpoints())
    expect(result.current).toEqual({ narrow900: true, narrow600: true, phone: true, narrowPanel: false })
  })

  test('updates state when a media query change event fires', () => {
    const matches = {
      [Q.narrow900]: false,
      [Q.narrow600]: false,
      [Q.phone]: false,
    }
    const stub = stubMatchMedia(matches)
    const { result } = renderHook(() => useNarrowBreakpoints())
    expect(result.current.narrow900).toBe(false)

    // Simulate the window shrinking below 900px: flip the backing value the
    // mocked MediaQueryList's `matches` getter reads, then fire its
    // registered change listener the way a real MediaQueryList would.
    matches[Q.narrow900] = true
    act(() => {
      stub.fire(Q.narrow900)
    })
    expect(result.current).toEqual({ narrow900: true, narrow600: false, phone: false, narrowPanel: false })
  })

  test('removes every change listener on unmount', () => {
    const stub = stubMatchMedia({
      [Q.narrow900]: false,
      [Q.narrow600]: false,
      [Q.phone]: false,
    })
    const { unmount } = renderHook(() => useNarrowBreakpoints())
    expect(stub.listenerCount(Q.narrow900)).toBe(1)
    expect(stub.listenerCount(Q.narrow600)).toBe(1)
    expect(stub.listenerCount(Q.phone)).toBe(1)
    unmount()
    expect(stub.listenerCount(Q.narrow900)).toBe(0)
    expect(stub.listenerCount(Q.narrow600)).toBe(0)
    expect(stub.listenerCount(Q.phone)).toBe(0)
  })
})

describe('the sidebar and an open task panel', () => {
  const noHidden = { name: false, due: false, project: false, priority: false, source: false }
  const ids = (cols) => cols.map((c) => c.id)

  test('the list thresholds sit one sidebar width beyond the widths they are named for', () => {
    expect(Q.narrow900).toBe('(max-width: 1132px)')
    expect(Q.narrow600).toBe('(max-width: 832px)')
    expect(Q.phone).toBe('(max-width: 640px)')
  })

  test('an open panel on a narrowPanel window hides Project too', () => {
    const visible = getVisibleColumns(noHidden, { narrow900: false, narrow600: false, phone: false, panelOpen: true, narrowPanel: true })
    expect(ids(visible)).toEqual(['name', 'due'])
  })

  test('narrowPanel alone, with no panel open, hides nothing', () => {
    const visible = getVisibleColumns(noHidden, { narrow900: false, narrow600: false, phone: false, panelOpen: false, narrowPanel: true })
    expect(ids(visible)).toEqual(['name', 'due', 'project', 'priority', 'source'])
  })
})
