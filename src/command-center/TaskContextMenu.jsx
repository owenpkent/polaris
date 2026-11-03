import { useCallback, useMemo, useState } from 'react'
import { CalendarCheck, CalendarDays, CalendarX, CheckCircle2, Circle, PanelRightOpen } from 'lucide-react'
import { Menu } from './Menu'
import { withDueDate } from './dueDates'

// The menu a right-click (or Shift+F10, or the ContextMenu key) opens on a task: a My tasks row or
// a Board card. It is the shared Menu (Menu.jsx), so it looks and behaves like the other row menus,
// and every item calls a handler the row already has; it adds no request of its own.

export const PRIORITY_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

const ICON = { size: 16, 'aria-hidden': 'true' }

// The items for one task. `onUpdate(task, patch)` is the row's quick edit. `projectOptions` (My tasks)
// or `sections` (the Board, with the task's current `sectionKey`) add the last group; `onMove`
// moves a card to a section. A due date keeps its time of day, as the row's own quick edits do.
export function taskMenuItems({ task, dueBounds, pending, onOpen, onToggleComplete, onUpdate, projectOptions, sections, sectionKey, onMove }) {
  const done = task.status === 'done'
  const items = [
    { key: 'open', label: 'Open task', icon: <PanelRightOpen {...ICON} />, onSelect: () => onOpen(task.id) },
    {
      key: 'complete',
      label: done ? 'Reopen' : 'Complete',
      icon: done ? <Circle {...ICON} /> : <CheckCircle2 {...ICON} />,
      disabled: pending,
      onSelect: () => onToggleComplete(task),
    },
    { key: 'sep-due', type: 'separator' },
    { key: 'h-due', type: 'header', label: 'Due' },
    { key: 'today', label: 'Today', icon: <CalendarCheck {...ICON} />, onSelect: () => onUpdate(task, { dueAt: withDueDate(task.dueAt, dueBounds.today) }) },
    { key: 'tomorrow', label: 'Tomorrow', icon: <CalendarDays {...ICON} />, onSelect: () => onUpdate(task, { dueAt: withDueDate(task.dueAt, dueBounds.tomorrow) }) },
    { key: 'noDue', label: 'No due date', icon: <CalendarX {...ICON} />, onSelect: () => onUpdate(task, { dueAt: null }) },
    { key: 'sep-priority', type: 'separator' },
    { key: 'h-priority', type: 'header', label: 'Priority' },
    ...PRIORITY_OPTIONS.map((opt) => ({
      key: `priority-${opt.value}`,
      label: opt.label,
      checked: (task.priority || 'none') === opt.value,
      radio: true,
      onSelect: () => onUpdate(task, { priority: opt.value }),
    })),
  ]
  if (projectOptions) {
    items.push(
      { key: 'sep-project', type: 'separator' },
      { key: 'h-project', type: 'header', label: 'Move to project' },
      { key: 'project-none', label: 'None', checked: !task.projectId, radio: true, onSelect: () => onUpdate(task, { projectId: null, sectionId: null }) },
      ...projectOptions.map((p) => ({
        key: `project-${p.id}`,
        label: p.name,
        checked: task.projectId === p.id,
        radio: true,
        onSelect: () => onUpdate(task, { projectId: p.id, sectionId: null }),
      }))
    )
  }
  if (sections) {
    items.push(
      { key: 'sep-section', type: 'separator' },
      { key: 'h-section', type: 'header', label: 'Move to' },
      ...sections.map((s) => ({
        key: `section-${s.id}`,
        label: s.name,
        checked: sectionKey === s.id,
        radio: true,
        onSelect: () => onMove(task, s.noSection ? null : s.id),
      }))
    )
  }
  return items
}

// A text field keeps the browser's own menu (paste, spell check), and a key typed in it is its own.
function inTextField(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'))
}

// Handlers for a row or card and the menu to render beside it (never inside it, so the menu's own
// events do not reach the row). `getItems` builds the items when the menu opens. The menu opens at
// the pointer for a right-click, and under the row for the keyboard; Esc returns focus to where it
// was.
export function useTaskContextMenu({ getItems, label }) {
  const [state, setState] = useState(null) // { point, el, returnTo } | null

  // Windows also sends a contextmenu event for the key that just opened the menu; it keeps the
  // keyboard-anchored menu rather than moving it to where the pointer last was.
  const openAt = useCallback((e, point) => {
    const el = e.currentTarget
    const returnTo = document.activeElement
    setState((prev) => (point && prev && !prev.point && prev.el === el ? prev : { point, el, returnTo }))
  }, [])

  const anchorRef = useMemo(() => {
    if (!state) return { current: null }
    const { point, el, returnTo } = state
    return {
      current: {
        getBoundingClientRect: () => (point
          ? { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 }
          : el.getBoundingClientRect()),
        contains: (node) => (point ? false : el.contains(node)),
        focus: () => { if (returnTo?.isConnected) returnTo.focus() },
      },
    }
  }, [state])

  const handlers = {
    onContextMenu(e) {
      if (inTextField(e.target)) return
      e.preventDefault()
      openAt(e, { x: e.clientX, y: e.clientY })
    },
    onKeyDown(e) {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
      if (inTextField(e.target)) return
      e.preventDefault()
      openAt(e, null)
    },
  }

  const close = useCallback(() => setState(null), [])
  const menu = state ? (
    <Menu anchorRef={anchorRef} open onClose={close} items={getItems()} label={label} minWidth={200} preferFit />
  ) : null

  return { handlers, menu }
}
