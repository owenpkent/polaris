import { useRef, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, CalendarCheck, CalendarDays, CalendarX, GripVertical } from 'lucide-react'
import { Menu } from './Menu'

// The grip at the left of a row under the manual sort. Dragging it moves the row
// (useReorderDrag.js); a click, Enter, or Space opens a menu with the same moves (up, down, to the
// top, to the bottom), and the arrow keys make the one-step moves without the menu, so nothing
// needs a drag (CONTRIBUTING.md, Accessibility). `reorder` comes from ReorderableRows.jsx:
// { index, count, groupId, onPointerDown, onMove, wasDrag, quick }. Under the due-date grouping the
// arrow keys also cross a group's edge (the row takes the other group's date), and the menu adds
// moves to Today, Tomorrow, and No due date, leaving out the group the row is already in.
export default function ReorderHandle({ task, reorder }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)
  const { index, count, groupId, onPointerDown, onMove, wasDrag, quick } = reorder
  const first = index === 0
  const last = index >= count - 1

  function handleKeyDown(e) {
    const action = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : null
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    if (!quick && ((action === 'up' && first) || (action === 'down' && last))) return
    onMove(task, action)
  }

  const items = [
    { key: 'up', label: 'Move up', icon: <ArrowUp size={16} aria-hidden="true" />, disabled: first, onSelect: () => onMove(task, 'up') },
    { key: 'down', label: 'Move down', icon: <ArrowDown size={16} aria-hidden="true" />, disabled: last, onSelect: () => onMove(task, 'down') },
    { key: 'top', label: 'Move to top', icon: <ArrowUpToLine size={16} aria-hidden="true" />, disabled: first, onSelect: () => onMove(task, 'top') },
    { key: 'bottom', label: 'Move to bottom', icon: <ArrowDownToLine size={16} aria-hidden="true" />, disabled: last, onSelect: () => onMove(task, 'bottom') },
  ]
  const QUICK_ITEMS = [
    { id: 'today', label: 'Move to Today', icon: <CalendarCheck size={16} aria-hidden="true" /> },
    { id: 'tomorrow', label: 'Move to Tomorrow', icon: <CalendarDays size={16} aria-hidden="true" /> },
    { id: 'noDue', label: 'Move to No due date', icon: <CalendarX size={16} aria-hidden="true" /> },
  ]
  if (quick) {
    for (const q of QUICK_ITEMS) {
      if (q.id === groupId || !quick.groups.includes(q.id)) continue
      items.push({ key: q.id, label: q.label, icon: q.icon, onSelect: () => quick.onMoveTo(task, q.id) })
    }
  }

  return (
    <>
      <button
        type="button"
        ref={ref}
        className="icon-btn reorder-handle"
        aria-label={`Reorder ${task.title}`}
        title="Drag to reorder, or open the menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, task, index) }}
        onClick={(e) => {
          e.stopPropagation()
          // The press that just ended was a drag, which has already moved the row.
          if (wasDrag()) return
          setOpen(true)
        }}
        onKeyDown={handleKeyDown}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <Menu anchorRef={ref} open={open} onClose={() => setOpen(false)} items={items} label={`Reorder ${task.title}`} minWidth={200} />
    </>
  )
}
