import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'

// Shared dropdown building blocks for My Tasks: a positioning/behavior shell
// (Popover) plus a ready-made list-of-items menu built on top of it (Menu).
// Every dropdown in the My Tasks list -- column header menus, the toolbar's
// Filter/Sort/Group/Columns buttons, and each row's Due date/Project/Priority
// pickers -- is one of these two, so keyboard behavior (arrow keys, Esc,
// click outside) and positioning (portaled to <body>, clamped to the
// viewport) only need to be right in one place.

// Move focus between an open dropdown's items with the arrow keys, and jump
// to the first/last with Home/End. Items are anything inside `containerRef`
// marked with `data-menu-item` that isn't disabled.
export function useRovingFocus(containerRef) {
  return useCallback((e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const items = Array.from(
      containerRef.current?.querySelectorAll('[data-menu-item]:not(:disabled)') || []
    )
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement)
    e.preventDefault()
    if (e.key === 'ArrowDown') items[(idx + 1) % items.length].focus()
    else if (e.key === 'ArrowUp') items[(idx <= 0 ? items.length - 1 : idx - 1)].focus()
    else if (e.key === 'Home') items[0].focus()
    else if (e.key === 'End') items[items.length - 1].focus()
  }, [containerRef])
}

// Portals its content to <body> and positions it near `anchorRef`, so a
// dropdown opened from the sticky My Tasks header (or from a header cell
// near the right edge of the page) is never clipped by either. Handles the
// behavior every dropdown needs: focuses its first item on open, closes on
// Esc (returning focus to the trigger) or on an outside click, and
// repositions itself if the page scrolls or resizes while it's open.
export function Popover({
  anchorRef,
  open,
  onClose,
  children,
  align = 'start',
  minWidth = 200,
  focusSelector = '[data-menu-item]:not(:disabled)',
}) {
  const popRef = useRef(null)
  const [pos, setPos] = useState(null)

  const reposition = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const a = anchor.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.max(minWidth, popRef.current?.offsetWidth || minWidth)
    let left = align === 'end' ? a.right - width : a.left
    left = Math.max(8, Math.min(left, vw - width - 8))
    const spaceBelow = vh - a.bottom
    const spaceAbove = a.top
    const openUp = spaceBelow < 160 && spaceAbove > spaceBelow
    setPos({
      left,
      top: openUp ? null : a.bottom + 4,
      bottom: openUp ? vh - a.top + 4 : null,
      maxHeight: Math.max(120, (openUp ? spaceAbove : spaceBelow) - 12),
    })
  }, [anchorRef, align, minWidth])

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    reposition()
  }, [open, reposition])

  // Refine once more after the first paint, once the popover's real
  // (content-driven) width is known -- the estimate above only has minWidth.
  useEffect(() => {
    if (!open) return undefined
    const id = requestAnimationFrame(reposition)
    return () => cancelAnimationFrame(id)
  }, [open, reposition])

  useEffect(() => {
    if (!open) return undefined
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, reposition])

  // Focus the first item on open. A menu that loads its items has nothing to focus at first,
  // only a header, so this runs again as the content changes and moves focus in once an item is
  // there, as long as focus has not already gone into the popover (a click on an item does that).
  // Without it the keyboard never reaches such a menu: the arrow keys are handled inside it.
  useEffect(() => {
    if (!open) return undefined
    const id = requestAnimationFrame(() => {
      const pop = popRef.current
      if (!pop || pop.contains(document.activeElement)) return
      pop.querySelector(focusSelector)?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [open, focusSelector, children])

  useEffect(() => {
    if (!open) return undefined
    function onPointerDown(e) {
      if (popRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return
      onClose()
    }
    function onKeyDown(e) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
      anchorRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, onClose, anchorRef])

  if (!open || !pos) return null

  return createPortal(
    <div
      ref={popRef}
      // Marks the portal for focus traps (TaskDetailPanel.jsx): focus in here belongs to the
      // trigger's own view even though the element sits at the end of <body>.
      data-popover=""
      // React bubbles portal events through the *component* tree, not the
      // DOM tree: a click way over here in <body> still reaches a row's
      // onClick (which opens the task detail panel) unless it's stopped
      // here. mousedown-based outside-click detection above is unaffected,
      // since that's a plain DOM listener rather than this synthetic event.
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top ?? undefined,
        bottom: pos.bottom ?? undefined,
        minWidth,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: pos.maxHeight,
        overflowY: 'auto',
        background: 'var(--bg3)',
        border: '1px solid var(--bd)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-pop)',
        zIndex: 300,
      }}
    >
      {children}
    </div>,
    document.body
  )
}

// A row inside a Menu: a plain action (`onSelect`), a checked/unchecked
// toggle (pass `checked`), one option of a mutually exclusive set (pass
// `checked` and `radio`, so a screen reader announces that picking one clears
// the others), a `separator`, or a non-interactive `header` label. `keepOpen`
// keeps the menu open after selection (for toggles like "show this column"
// where picking one item shouldn't close the rest).
function MenuRow({ item }) {
  if (item.type === 'separator') {
    return <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '6px 0' }} />
  }
  if (item.type === 'header') {
    return <div style={{ padding: '6px 14px 4px', fontSize: 12, color: 'var(--t2)' }}>{item.label}</div>
  }
  return (
    <button
      type="button"
      className="hover-surface"
      role={item.checked === undefined ? 'menuitem' : item.radio ? 'menuitemradio' : 'menuitemcheckbox'}
      aria-checked={item.checked}
      data-menu-item
      disabled={item.disabled}
      onClick={() => {
        item.onSelect?.()
        if (!item.keepOpen) item.onAfterSelect?.()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        width: '100%',
        minHeight: 44,
        padding: '0 14px',
        background: 'transparent',
        border: 'none',
        textAlign: 'left',
        font: 'inherit',
        fontSize: 14,
        color: item.disabled ? 'var(--t2)' : 'var(--t1)',
        cursor: item.disabled ? 'default' : 'pointer',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.icon}
        {item.label}
      </span>
      {item.checked && <Check size={16} style={{ flexShrink: 0 }} />}
    </button>
  )
}

// A Popover whose content is a simple vertical list of items (see MenuRow).
// Covers every dropdown that isn't a custom picker: column header menus,
// and the toolbar's Sort/Group/Columns buttons.
export function Menu({ anchorRef, open, onClose, items, align, minWidth, label }) {
  const listRef = useRef(null)
  const onKeyDown = useRovingFocus(listRef)

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} align={align} minWidth={minWidth}>
      <div ref={listRef} role="menu" aria-label={label} onKeyDown={onKeyDown} style={{ padding: '6px 0' }}>
        {items.map((item, i) => (
          <MenuRow key={item.key ?? i} item={{ ...item, onAfterSelect: onClose }} />
        ))}
      </div>
    </Popover>
  )
}
