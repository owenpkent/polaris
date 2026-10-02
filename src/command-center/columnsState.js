import { useCallback, useEffect, useState } from 'react'

// Column model for the My Tasks grid: which columns exist, their fixed
// order, and their sizing rules. Every column has a stored pixel width; an
// empty filler track after the last column takes the leftover row width, so
// dragging a column's right edge moves exactly that edge. Name is always
// visible; the rest can be hidden. `sortField` is the id this column sorts
// by when a header menu's "Sort ascending/descending" is used (null for
// Source, which isn't sortable) -- it lines up with SORT_FIELDS in viewState.js.
export const COLUMN_DEFS = [
  { id: 'name', label: 'Name', minWidth: 160, defaultWidth: 440, canHide: false, sortField: 'name' },
  { id: 'due', label: 'Due date', minWidth: 90, defaultWidth: 130, canHide: true, sortField: 'due' },
  { id: 'project', label: 'Project', minWidth: 90, defaultWidth: 180, canHide: true, sortField: 'project' },
  { id: 'priority', label: 'Priority', minWidth: 80, defaultWidth: 100, canHide: true, sortField: 'priority' },
  { id: 'source', label: 'Source', minWidth: 80, defaultWidth: 120, canHide: true, sortField: null },
]

const MAX_WIDTH = 1200
const COLUMNS_STORAGE_KEY = 'cc-mytasks-columns-v1'

function defaultState() {
  const widths = {}
  const hidden = {}
  for (const col of COLUMN_DEFS) {
    widths[col.id] = col.defaultWidth
    hidden[col.id] = false
  }
  return { widths, hidden }
}

function loadColumns() {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function saveColumns(state) {
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
}

function clampWidth(col, width) {
  return Math.max(col.minWidth, Math.min(width, MAX_WIDTH))
}

// Widths and hidden-state for every column, persisted to localStorage.
export function useColumnsState() {
  const [state, setState] = useState(() => {
    const base = defaultState()
    const loaded = loadColumns()
    if (!loaded) return base
    return {
      widths: { ...base.widths, ...loaded.widths },
      hidden: { ...base.hidden, ...loaded.hidden },
    }
  })

  const commit = useCallback((updater) => {
    setState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      saveColumns(next)
      return next
    })
  }, [])

  const setWidth = useCallback((id, width) => {
    const col = COLUMN_DEFS.find((c) => c.id === id)
    if (!col) return
    commit((prev) => ({ ...prev, widths: { ...prev.widths, [id]: clampWidth(col, width) } }))
  }, [commit])

  const resetWidth = useCallback((id) => {
    const col = COLUMN_DEFS.find((c) => c.id === id)
    if (!col) return
    commit((prev) => ({ ...prev, widths: { ...prev.widths, [id]: col.defaultWidth } }))
  }, [commit])

  const setHidden = useCallback((id, isHidden) => {
    const col = COLUMN_DEFS.find((c) => c.id === id)
    if (!col || !col.canHide) return
    commit((prev) => ({ ...prev, hidden: { ...prev.hidden, [id]: isHidden } }))
  }, [commit])

  return { widths: state.widths, hidden: state.hidden, setWidth, resetWidth, setHidden }
}

// Tracks the app's three breakpoints: the two the My Tasks grid used to hide
// columns at via plain CSS (900px: Source/Priority, 600px: Project), plus the
// single phone breakpoint (640px) the whole dashboard uses for its phone
// layout tier. Column widths are computed in JS so they stay aligned between
// the header and every row, so this responsive hiding has to move to JS too
// -- otherwise an inline gridTemplateColumns would silently defeat a media
// query.
export function useNarrowBreakpoints() {
  const [state, setState] = useState(() => ({
    narrow900: typeof window !== 'undefined' ? window.innerWidth <= 900 : false,
    narrow600: typeof window !== 'undefined' ? window.innerWidth <= 600 : false,
    phone: typeof window !== 'undefined' ? window.innerWidth <= 640 : false,
  }))

  useEffect(() => {
    const mq900 = window.matchMedia('(max-width: 900px)')
    const mq600 = window.matchMedia('(max-width: 600px)')
    const mqPhone = window.matchMedia('(max-width: 640px)')
    const update = () => setState({ narrow900: mq900.matches, narrow600: mq600.matches, phone: mqPhone.matches })
    update()
    mq900.addEventListener('change', update)
    mq600.addEventListener('change', update)
    mqPhone.addEventListener('change', update)
    return () => {
      mq900.removeEventListener('change', update)
      mq600.removeEventListener('change', update)
      mqPhone.removeEventListener('change', update)
    }
  }, [])

  return state
}

// Which columns actually render, combining the user's own hide/show choices
// with the responsive rules above and (matching the previous mt-panel-open
// CSS) hiding Priority/Source while the task detail panel is open so Name
// and Due date have room. On the phone tier the column set is fixed to
// checkbox + Name + Due date regardless of the saved hidden state or an open
// panel -- there isn't room for anything else.
export function getVisibleColumns(hidden, { narrow900, narrow600, phone, panelOpen }) {
  return COLUMN_DEFS.filter((col) => {
    if (!col.canHide) return true
    if (phone) return col.id === 'due'
    if (hidden[col.id]) return false
    if ((narrow900 || panelOpen) && (col.id === 'priority' || col.id === 'source')) return false
    if (narrow600 && col.id === 'project') return false
    return true
  })
}

// The grid-template-columns string shared by the header row and every
// TaskRow/InlineTaskInput, so a column's width can never drift out of sync
// between them. On the phone tier the template is fixed (checkbox, Name
// filling the rest, Due date) and ignores saved widths so the grid is
// exactly the viewport width, with no trailing filler track. Otherwise it
// always starts with the fixed 44px checkbox column and ends with an empty
// filler track; each column is minmax(min, width): at its stored width when
// the row has room, shrinking toward its minimum (instead of overflowing the
// page) when the window or an open detail panel is narrow.
export function buildGridTemplate(visibleColumns, widths, { phone } = {}) {
  if (phone) return '44px minmax(0, 1fr) 112px'
  const tracks = visibleColumns.map((col) => `minmax(${col.minWidth}px, ${widths[col.id] ?? col.defaultWidth}px)`)
  return ['44px', ...tracks, 'minmax(0, 1fr)'].join(' ')
}
