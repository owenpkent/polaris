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

// Above the phone breakpoint the sidebar (src/Sidebar.jsx, .app-sidebar in index.css, which must
// stay this wide) takes this much of the window, so the list's own thresholds, which are about the
// width the list really has, sit that much further out than the window width they are named for.
export const SIDEBAR_WIDTH = 232

// The media queries behind useNarrowBreakpoints. narrow900 and narrow600 are the two widths the My
// Tasks list used to hide columns at via plain CSS (900px: Source/Priority, 600px: Project),
// measured on the list rather than the window. phone is the single phone breakpoint (640px) the
// whole dashboard uses for its phone layout tier. narrowPanel is where an open task panel leaves
// the list too little room for Project as well.
export const BREAKPOINT_QUERIES = {
  narrow900: `(max-width: ${900 + SIDEBAR_WIDTH}px)`,
  narrow600: `(max-width: ${600 + SIDEBAR_WIDTH}px)`,
  phone: '(max-width: 640px)',
  narrowPanel: '(max-width: 1440px)',
}

const BREAKPOINT_KEYS = Object.keys(BREAKPOINT_QUERIES)

function widthOf(query) {
  return Number(/max-width: (\d+)px/.exec(query)[1])
}

// Column widths are computed in JS so they stay aligned between the header and every row, so
// this responsive hiding has to live in JS too -- otherwise an inline gridTemplateColumns would
// silently defeat a media query.
export function useNarrowBreakpoints() {
  const [state, setState] = useState(() => {
    const initial = {}
    for (const key of BREAKPOINT_KEYS) {
      initial[key] = typeof window !== 'undefined' ? window.innerWidth <= widthOf(BREAKPOINT_QUERIES[key]) : false
    }
    return initial
  })

  useEffect(() => {
    const lists = BREAKPOINT_KEYS.map((key) => [key, window.matchMedia(BREAKPOINT_QUERIES[key])])
    const update = () => setState(Object.fromEntries(lists.map(([key, mq]) => [key, mq.matches])))
    update()
    for (const [, mq] of lists) mq.addEventListener('change', update)
    return () => {
      for (const [, mq] of lists) mq.removeEventListener('change', update)
    }
  }, [])

  return state
}

// Which columns actually render, combining the user's own hide/show choices
// with the responsive rules above and (matching the previous mt-panel-open
// CSS) hiding Priority/Source while the task detail panel is open so Name
// and Due date have room, and Project too when the window is narrowPanel or
// less, since the sidebar and the panel then leave the list little width. On the phone tier the column set is fixed to
// checkbox + Name + Due date regardless of the saved hidden state or an open
// panel -- there isn't room for anything else.
export function getVisibleColumns(hidden, { narrow900, narrow600, phone, panelOpen, narrowPanel = false }) {
  return COLUMN_DEFS.filter((col) => {
    if (!col.canHide) return true
    if (phone) return col.id === 'due'
    if (hidden[col.id]) return false
    if ((narrow900 || panelOpen) && (col.id === 'priority' || col.id === 'source')) return false
    if ((narrow600 || (panelOpen && narrowPanel)) && col.id === 'project') return false
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
