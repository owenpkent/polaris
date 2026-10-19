import { useRef, useState } from 'react'
import { Check, Repeat } from 'lucide-react'
import { formatDueCell, plainTitle, repeatLabel } from './dueDates'
import { Menu } from './Menu'
import { Avatar, ProjectChip } from './shared'
import DueDateMenu from './DueDateMenu'
import CompleteBurst, { useCelebration } from './CompleteBurst'

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
function CellButton({ innerRef, onClick, color, placeholder, children, ariaLabel, title, hasPopup = 'menu' }) {
  return (
    <button
      type="button"
      ref={innerRef}
      aria-haspopup={hasPopup}
      aria-label={ariaLabel}
      title={title}
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

function DueDateCell({ task, dueBounds, onUpdate, phone, api }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const due = formatDueCell(task.dueAt, dueBounds)
  // A repeating task shows a small repeat glyph after its date; the name says how it repeats.
  const repeat = repeatLabel(task.recurrence)

  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <CellButton
        innerRef={btnRef}
        ariaLabel={`Change due date for ${task.title}${repeat ? `, repeats ${repeat}` : ''}`}
        hasPopup="dialog"
        onClick={() => setOpen((v) => !v)}
        color={due.color}
        // A narrow column can cut a date and time short; the whole of it is a hover away.
        title={due.text || undefined}
      >
        {phone && due.text ? (
          // The day and the time each stay whole, and the time takes a second line when the
          // column is too narrow for both.
          <span
            className={due.time ? 'due-chip has-time' : 'due-chip'}
            style={{ background: CHIP_BACKGROUNDS[due.color] || 'var(--neutral-soft)', color: due.color || 'var(--t1)' }}
          >
            {due.time ? (
              <>
                <span>{due.date}</span> <span>{due.time}</span>
              </>
            ) : due.text}
          </span>
        ) : (
          due.text
        )}
        {repeat && <Repeat size={12} aria-hidden="true" className="repeat-glyph" />}
      </CellButton>
      <DueDateMenu
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        value={task.dueAt}
        dueBounds={dueBounds}
        onChange={(value, recurrence) => onUpdate(task, recurrence === undefined ? { dueAt: value } : { dueAt: value, recurrence })}
        recurrence={task.recurrence}
        onRecurrenceChange={(recurrence, dueAt) => onUpdate(task, dueAt === undefined ? { recurrence } : { recurrence, dueAt })}
        api={api}
        label={`Due date for ${task.title}`}
      />
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
  api,
}) {
  const done = task.status === 'done'
  const columnIds = new Set(visibleColumns.map((c) => c.id))
  // Held until the refetch drops the completed row, so it never reappears between its fade and
  // its removal. Only a completion clicked here celebrates, and a rollback (done turns false)
  // ends it at once.
  const { celebrating, key: burstKey, celebrate } = useCelebration({ hold: true })
  const completing = celebrating && done

  function handleKeyDown(e) {
    if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault()
      onOpen(task.id)
    }
  }

  return (
    <div
      className={completing ? 'mytasks-grid mytasks-row is-completing' : 'mytasks-grid mytasks-row'}
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
          if (!done) celebrate()
          onToggleComplete(task)
        }}
        style={{
          position: 'relative',
          width: 44,
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          borderRadius: 8,
          cursor: pending ? 'default' : 'pointer',
          // The check keeps its full colour while it celebrates, though the request is pending.
          opacity: pending && !completing ? 0.6 : 1,
        }}
      >
        {/* The tick is always drawn but transparent until the task is done or the button is
            hovered (.task-check-circle), so the circle is empty at rest. */}
        <span
          key={completing ? burstKey : 0}
          aria-hidden="true"
          className={`task-check-circle${done ? ' is-done' : ''}${completing ? ' check-pop' : ''}`}
        >
          <Check size={12} strokeWidth={3} />
        </span>
        {completing && <CompleteBurst key={burstKey} />}
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

      {columnIds.has('due') && <DueDateCell task={task} dueBounds={dueBounds} onUpdate={onQuickUpdate} phone={phone} api={api} />}
      {columnIds.has('project') && (
        <ProjectCell task={task} projectName={projectName} projectOptions={projectOptions} onUpdate={onQuickUpdate} />
      )}
      {columnIds.has('assignee') && (
        // Read-only here: who a task goes to is set in the panel, where Assign to and Take back live.
        <span style={{ ...cellStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
          {task.assignee ? (
            <>
              <Avatar name={task.assignee} size={22} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.assignee}</span>
            </>
          ) : null}
        </span>
      )}
      {columnIds.has('priority') && <PriorityCell task={task} onUpdate={onQuickUpdate} />}
      {columnIds.has('source') && <span style={cellStyle}>{SOURCE_LABELS[task.sourceType] || ''}</span>}
    </div>
  )
}
