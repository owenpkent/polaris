import { useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { formatDueCell, plainTitle, localIso, addDays } from './dueDates'
import { Menu, Popover, useRovingFocus } from './Menu'
import { ProjectChip } from './shared'

// Priority is a soft pill in this view (.priority-pill in index.css): nothing for none and
// medium (the default), so a pill always means a level was chosen.
const PRIORITY_DISPLAY = {
  low: { label: 'Low', className: 'badge priority-pill is-low' },
  high: { label: 'High', className: 'badge priority-pill is-high' },
  urgent: { label: 'Urgent', className: 'badge priority-pill is-urgent' },
}

const PRIORITY_MENU_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

export const SOURCE_LABELS = {
  github: 'GitHub',
  git_local: 'Git',
  code_todo: 'Code',
  todo_md: 'TODO.md',
  status_md: 'Status doc',
  initiative_md: 'Initiative',
  gmail: 'Gmail',
  gdrive: 'Drive',
  gcal: 'Calendar',
  manual: 'Manual',
}

const cellStyle = {
  minWidth: 0,
  fontSize: '0.875rem',
  color: 'var(--t2)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

// A cell that opens a dropdown instead of the task detail panel. Stops the
// click from bubbling to the row (which opens the panel) and renders as a
// full-height, full-width button so the whole cell -- not just its text --
// is the 44px-tall click target.
function CellButton({ innerRef, onClick, color, placeholder, children, ariaLabel }) {
  return (
    <button
      type="button"
      ref={innerRef}
      aria-haspopup="menu"
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{
        ...cellStyle,
        display: 'block',
        width: '100%',
        height: '100%',
        minHeight: 44,
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderRadius: 6,
        color: children ? color || 'var(--t2)' : 'var(--t2)',
        cursor: 'pointer',
      }}
    >
      {children || placeholder}
    </button>
  )
}

// The soft background behind a phone due chip, matching the text colour formatDueCell chose.
const CHIP_BACKGROUNDS = { 'var(--green)': 'var(--green-soft)', 'var(--red)': 'var(--red-soft)' }

function DueDateCell({ task, dueBounds, onUpdate, phone }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const listRef = useRef(null)
  const onKeyDown = useRovingFocus(listRef)
  const due = formatDueCell(task.dueAt, dueBounds)
  const dateOnly = task.dueAt ? task.dueAt.slice(0, 10) : ''

  const now = new Date()
  const nextMondayDays = ((1 - now.getDay() + 7) % 7) || 7

  function commit(value) {
    setOpen(false)
    onUpdate(task, { dueAt: value })
  }

  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <CellButton innerRef={btnRef} ariaLabel={`Change due date for ${task.title}`} onClick={() => setOpen((v) => !v)} color={due.color}>
        {phone && due.text ? (
          <span
            className="due-chip"
            style={{ background: CHIP_BACKGROUNDS[due.color] || 'var(--neutral-soft)', color: due.color || 'var(--t1)' }}
          >
            {due.text}
          </span>
        ) : (
          due.text
        )}
      </CellButton>
      <Popover anchorRef={btnRef} open={open} onClose={() => setOpen(false)} minWidth={200}>
        <div ref={listRef} role="menu" aria-label={`Due date for ${task.title}`} onKeyDown={onKeyDown} style={{ padding: '6px 0' }}>
          {[
            { key: 'today', label: 'Today', value: dueBounds.today },
            { key: 'tomorrow', label: 'Tomorrow', value: dueBounds.tomorrow },
            { key: 'monday', label: 'Next Monday', value: localIso(addDays(now, nextMondayDays)) },
            { key: 'week', label: 'In one week', value: localIso(addDays(now, 7)) },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="menuitem"
              data-menu-item
              onClick={() => commit(opt.value)}
              style={menuItemStyle}
            >
              {opt.label}
            </button>
          ))}
          <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '6px 0' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '0 14px', fontSize: 14, color: 'var(--t1)' }}>
            <span style={{ flexShrink: 0, color: 'var(--t2)' }}>Date</span>
            <input
              type="date"
              data-menu-item
              value={dateOnly}
              onChange={(e) => commit(e.target.value || null)}
              style={{ flexGrow: 1, minWidth: 0, height: 32, padding: '0 8px', fontSize: 13 }}
            />
          </label>
          <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '6px 0' }} />
          <button type="button" role="menuitem" data-menu-item onClick={() => commit(null)} style={menuItemStyle}>
            Clear
          </button>
        </div>
      </Popover>
    </div>
  )
}

function ProjectCell({ task, projectName, projectOptions, onUpdate }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)

  // Changing project also clears sectionId: a section belongs to one
  // project, so keeping the old one would leave it pointing at a section
  // under a different (or no) project. There is no section picker here.
  const items = [
    { key: 'none', label: 'None', checked: !task.projectId, onSelect: () => onUpdate(task, { projectId: null, sectionId: null }) },
    ...projectOptions.map((p) => ({
      key: p.id,
      label: p.name,
      checked: task.projectId === p.id,
      onSelect: () => onUpdate(task, { projectId: p.id, sectionId: null }),
    })),
  ]

  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <CellButton innerRef={btnRef} ariaLabel={`Change project for ${task.title}`} onClick={() => setOpen((v) => !v)} placeholder="None">
        {projectName ? <ProjectChip name={projectName} /> : null}
      </CellButton>
      <Menu anchorRef={btnRef} open={open} onClose={() => setOpen(false)} items={items} label={`Project for ${task.title}`} minWidth={200} />
    </div>
  )
}

function PriorityCell({ task, onUpdate }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const priority = PRIORITY_DISPLAY[task.priority]

  const items = PRIORITY_MENU_OPTIONS.map((opt) => ({
    key: opt.value,
    label: opt.label,
    checked: (task.priority || 'none') === opt.value,
    onSelect: () => onUpdate(task, { priority: opt.value }),
  }))

  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      {/* Blank (not "None") for both the "none" and "medium" priority values,
          matching the read-only display this replaces -- medium is the
          default level and isn't called out visually. */}
      <CellButton innerRef={btnRef} ariaLabel={`Change priority for ${task.title}`} onClick={() => setOpen((v) => !v)}>
        {priority ? <span className={priority.className}>{priority.label}</span> : null}
      </CellButton>
      <Menu anchorRef={btnRef} open={open} onClose={() => setOpen(false)} items={items} label={`Priority for ${task.title}`} minWidth={160} />
    </div>
  )
}

const menuItemStyle = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  minHeight: 44,
  padding: '0 14px',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  font: 'inherit',
  fontSize: 14,
  color: 'var(--t1)',
  cursor: 'pointer',
}

// One task row in the My Tasks grid. The row opens the task detail panel
// (click or Enter while focused); the check circle and the Due
// date/Project/Priority cells are their own controls so completing a task,
// or changing one of those three fields, never requires opening the panel.
export default function TaskRow({
  task,
  projectName,
  projectOptions,
  dueBounds,
  pending,
  open,
  visibleColumns,
  gridTemplateColumns,
  phone,
  onToggleComplete,
  onOpen,
  onQuickUpdate,
}) {
  const done = task.status === 'done'
  const columnIds = new Set(visibleColumns.map((c) => c.id))

  function handleKeyDown(e) {
    if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault()
      onOpen(task.id)
    }
  }

  return (
    <div
      className="mytasks-grid mytasks-row"
      role="button"
      tabIndex={0}
      aria-label={`Open ${task.title}`}
      data-task-id={task.id}
      onClick={() => onOpen(task.id)}
      onKeyDown={handleKeyDown}
      style={{
        gridTemplateColumns,
        alignItems: 'center',
        minHeight: 44,
        borderBottom: '1px solid var(--bd)',
        cursor: 'pointer',
        background: open ? 'var(--bg-selected)' : undefined,
        boxShadow: open ? 'inset 3px 0 0 var(--blue)' : undefined,
      }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        disabled={pending}
        className="task-check"
        onClick={(e) => {
          e.stopPropagation()
          onToggleComplete(task)
        }}
        style={{
          width: 44,
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          borderRadius: 8,
          cursor: pending ? 'default' : 'pointer',
          opacity: pending ? 0.6 : 1,
        }}
      >
        {/* The check is always drawn; the circle's colour hides it until the task is done or
            the button is hovered (.task-check-circle). */}
        <span aria-hidden="true" className={done ? 'task-check-circle is-done' : 'task-check-circle'}>
          <Check size={12} strokeWidth={3} />
        </span>
      </button>

      <span
        style={
          phone
            ? {
                ...cellStyle,
                fontSize: '0.9375rem',
                color: done ? 'var(--t2)' : 'var(--t1)',
                textDecoration: done ? 'line-through' : 'none',
                whiteSpace: 'normal',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                padding: '10px 0',
              }
            : {
                ...cellStyle,
                fontSize: '0.875rem',
                color: done ? 'var(--t2)' : 'var(--t1)',
                textDecoration: done ? 'line-through' : 'none',
                paddingRight: 12,
              }
        }
      >
        {plainTitle(task.title)}
        {task.status === 'waiting' && (
          <span style={{ display: 'inline-block', marginLeft: '0.6rem', fontSize: '0.75rem', color: 'var(--t2)' }}>
            Waiting
          </span>
        )}
      </span>

      {columnIds.has('due') && <DueDateCell task={task} dueBounds={dueBounds} onUpdate={onQuickUpdate} phone={phone} />}
      {columnIds.has('project') && (
        <ProjectCell task={task} projectName={projectName} projectOptions={projectOptions} onUpdate={onQuickUpdate} />
      )}
      {columnIds.has('priority') && <PriorityCell task={task} onUpdate={onQuickUpdate} />}
      {columnIds.has('source') && <span style={cellStyle}>{SOURCE_LABELS[task.sourceType] || ''}</span>}
    </div>
  )
}
