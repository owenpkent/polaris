import { useCallback, useRef, useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Menu } from './Menu'

const HANDLE_WIDTH = 12
const ARROW_STEP = 10
const MENU_STEP = 24

// One cell of the My Tasks header row: the column label, a menu button
// (sort, widen/narrow/reset, hide), and a drag handle on the right edge for
// resizing. `sort` is the list's current { field, dir } so the menu can show
// which one is active.
const MAX_HANDLE_VALUE = 2000

export default function ColumnHeader({ column, phone, sort, onSetWidth, onResetWidth, onSetSort, onHide }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [handleFocused, setHandleFocused] = useState(false)
  const cellRef = useRef(null)
  const menuBtnRef = useRef(null)
  const handleRef = useRef(null)
  const dragRef = useRef(null)

  // Sizes always start from the rendered width, not the stored one: on a
  // narrow window a column can be drawn narrower than its stored width, and
  // starting from the stored width would make the edge jump or stall.
  const renderedWidth = () => cellRef.current?.getBoundingClientRect().width ?? 0
  // A focusable separator must carry its value (WAI-ARIA window splitter, axe aria-required-attr):
  // the column's rendered width in pixels, read after each render that can change it.
  const [handleValue, setHandleValue] = useState(0)
  useEffect(() => {
    setHandleValue(Math.min(MAX_HANDLE_VALUE, Math.round(renderedWidth())))
  })

  const nudge = useCallback((delta) => {
    onSetWidth(column.id, Math.round(renderedWidth() + delta))
  }, [column.id, onSetWidth])

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    handleRef.current?.setPointerCapture?.(e.pointerId)
    dragRef.current = { startX: e.clientX, startWidth: renderedWidth() }
    setDragging(true)
  }, [])

  const handlePointerMove = useCallback((e) => {
    if (!dragRef.current) return
    onSetWidth(column.id, Math.round(dragRef.current.startWidth + (e.clientX - dragRef.current.startX)))
  }, [column.id, onSetWidth])

  const endDrag = useCallback((e) => {
    if (!dragRef.current) return
    handleRef.current?.releasePointerCapture?.(e.pointerId)
    dragRef.current = null
    setDragging(false)
  }, [])

  function handleKeyDown(e) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      nudge(-ARROW_STEP)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      nudge(ARROW_STEP)
    }
  }

  const sortActive = Boolean(column.sortField) && sort.field === column.sortField
  const items = [
    column.sortField && { key: 'sort-asc', label: 'Sort ascending', checked: sortActive && sort.dir === 'asc', onSelect: () => onSetSort(column.sortField, 'asc') },
    column.sortField && { key: 'sort-desc', label: 'Sort descending', checked: sortActive && sort.dir === 'desc', onSelect: () => onSetSort(column.sortField, 'desc') },
    column.sortField && { type: 'separator', key: 'sep-sort' },
    { key: 'wider', label: 'Wider', keepOpen: true, onSelect: () => nudge(MENU_STEP) },
    { key: 'narrower', label: 'Narrower', keepOpen: true, onSelect: () => nudge(-MENU_STEP) },
    { key: 'reset', label: 'Reset width', onSelect: () => onResetWidth(column.id) },
    column.canHide && { type: 'separator', key: 'sep-hide' },
    column.canHide && { key: 'hide', label: 'Hide column', onSelect: () => onHide(column.id) },
  ].filter(Boolean)

  return (
    <div
      ref={cellRef}
      className="mytasks-th"
      style={{ position: 'relative', display: 'flex', alignItems: 'center', minWidth: 0, height: '100%', paddingRight: HANDLE_WIDTH / 2 }}
    >
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flexGrow: 1,
          minWidth: 0,
          fontSize: '0.8125rem',
          fontWeight: 500,
          color: 'var(--t2)',
        }}
      >
        {column.label}
      </span>
      <button
        type="button"
        ref={menuBtnRef}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${column.label} column menu`}
        onClick={() => setMenuOpen((v) => !v)}
        style={{
          width: 44,
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          borderRadius: 8,
          color: 'var(--t2)',
        }}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <Menu
        anchorRef={menuBtnRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={items}
        align="end"
        minWidth={200}
        label={`${column.label} column menu`}
      />

      {/* The resize handle claims touchAction: 'none' so a horizontal drag
          isn't mistaken for a page scroll, but that same rule would also
          swallow a vertical scroll gesture on a phone, where dragging to
          resize isn't offered anyway (there's no room, and the column set
          is fixed) -- so it's left out of the DOM entirely on that tier. */}
      {!phone && (
        <div
          ref={handleRef}
          className={dragging || handleFocused ? 'col-resize-handle is-active' : 'col-resize-handle'}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${column.label} column`}
          aria-valuenow={handleValue}
          aria-valuemin={0}
          aria-valuemax={MAX_HANDLE_VALUE}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => onResetWidth(column.id)}
          onKeyDown={handleKeyDown}
          onFocus={() => setHandleFocused(true)}
          onBlur={() => setHandleFocused(false)}
          style={{
            position: 'absolute',
            right: -HANDLE_WIDTH / 2,
            top: 0,
            bottom: 0,
            width: HANDLE_WIDTH,
            cursor: 'col-resize',
            touchAction: 'none',
            zIndex: 1,
          }}
        />
      )}
    </div>
  )
}
