import { useLayoutEffect, useRef, useState } from 'react'
import ReorderHandle from './ReorderHandle'
import { Check, ChevronDown, ChevronRight, ListTree, PanelRightOpen, Repeat } from 'lucide-react'
import { formatDueCell, plainTitle, repeatLabel } from './dueDates'
import { Menu } from './Menu'
import { Avatar, ProjectChip } from './shared'
import DueDateMenu from './DueDateMenu'
import { useComposition } from './imeComposition'
import CompleteBurst, { useCelebration } from './CompleteBurst'
import { PRIORITY_OPTIONS, taskMenuItems, useTaskContextMenu } from './TaskContextMenu'

// Priority is a soft pill in this view (.priority-pill in index.css): nothing for none and
// medium (the default), so a pill always means a level was chosen.
const PRIORITY_DISPLAY = {
  low: { label: 'Low', className: 'badge priority-pill is-low' },
  high: { label: 'High', className: 'badge priority-pill is-high' },
  urgent: { label: 'Urgent', className: 'badge priority-pill is-urgent' },
}

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
// is the row-tall click target (44px, or 32px under Compact density).
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
        minHeight: 'var(--row)',
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

  const items = PRIORITY_OPTIONS.map((opt) => ({
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

// How deep subtasks open under a task in the list; a subtask that deep shows its count only.
const MAX_SUBTASK_DEPTH = 3

// The count of a task's open subtasks after its name, as Asana's list shows it, and the control
// that shows them under it: one button, the whole 44px cell height, which says how many and,
// through aria-expanded, whether they are shown. It never opens the task.
function SubtaskToggle({ task, count, expanded, onToggle }) {
  const label = `${count} open ${count === 1 ? 'subtask' : 'subtasks'} of ${task.title}`
  if (!onToggle) {
    return (
      <span className="subtask-chip is-static" role="img" aria-label={label}>
        <ListTree size={12} aria-hidden="true" />
        {count}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="subtask-toggle"
      aria-expanded={expanded}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <span className="subtask-chip" aria-hidden="true">
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ListTree size={12} />
        {count}
      </span>
    </button>
  )
}

// Where a click landed in the text of `container`, as a character offset, or null when the
// browser cannot say (no caret API, or the point is not on text).
function caretOffsetAt(container, x, y) {
  let node = null
  let offset = 0
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y)
    node = pos?.offsetNode ?? null
    offset = pos?.offset ?? 0
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y)
    node = range?.startContainer ?? null
    offset = range?.startOffset ?? 0
  }
  return node && node.nodeType === 3 && container.contains(node) ? offset : null
}

// A task's name in its row. Clicking the text, or Enter or Space on it, edits the name in place
// (Asana's list does the same): Enter or a click away saves through `onRename`, Esc puts the old
// name back, and an empty or unchanged name saves nothing. The rest of the name cell is the row,
// which opens the panel. The text shown has markdown stripped (plainTitle), so the caret goes
// where the click was only when that text is the stored title; otherwise it goes to the end.
function TitleCell({ task, nameText, disabled, onRename }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const buttonRef = useRef(null)
  const inputRef = useRef(null)
  const caret = useRef(null)
  const finished = useRef(true)
  const refocus = useRef(false)
  const ime = useComposition()

  useLayoutEffect(() => {
    if (editing) {
      const input = inputRef.current
      input.focus()
      const at = Math.min(caret.current ?? input.value.length, input.value.length)
      input.setSelectionRange(at, at)
    } else if (refocus.current) {
      refocus.current = false
      buttonRef.current?.focus()
    }
  }, [editing])

  function start(e) {
    e.stopPropagation()
    // A click has a position; Enter or Space on the button has none (detail 0).
    caret.current = e.detail > 0 && plainTitle(task.title) === task.title
      ? caretOffsetAt(e.currentTarget, e.clientX, e.clientY)
      : null
    finished.current = false
    setDraft(task.title)
    setEditing(true)
  }

  // The first of Enter, Esc, and blur ends the edit; the blur that follows the others is ignored.
  function finish(save, returnFocus) {
    if (finished.current) return
    finished.current = true
    refocus.current = returnFocus
    const next = draft.trim()
    setEditing(false)
    if (save && next && next !== task.title) onRename(next)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        className="mytasks-title-input"
        aria-label="Task name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => finish(true, false)}
        {...ime.props}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (ime.isComposing(e)) return
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(true, true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish(false, true)
          }
        }}
      />
    )
  }
  return (
    <button type="button" ref={buttonRef} className="mytasks-title" aria-label={`Rename ${task.title}`} disabled={disabled} onClick={start}>
      <span style={nameText}>{plainTitle(task.title)}</span>
    </button>
  )
}

// One task row in the My Tasks grid. The panel button ending the name cell ("Open <title>") is
// the keyboard and assistive-technology way to the task detail panel; a click on the rest of the
// row opens it too, for the pointer. The name edits in
// place (TitleCell); the check circle and the Due
// date/Project/Priority cells are their own controls so completing a task,
// or changing one of those three fields, never requires opening the panel.
// `depth` above 0 is a subtask shown under its parent (TaskTree below): the check moves into the
// name cell, indented, so the columns still line up. `subtaskCount` and `onToggleExpand` draw the
// subtask count after the name; `expanded` says whether the subtasks are shown under the row.
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
  depth = 0,
  subtaskCount = 0,
  expanded = false,
  onToggleExpand,
  // Under the manual sort every top-level row has a leading 44px cell (handleColumn) holding its
  // reorder handle (`reorder`, from ReorderableRows.jsx), and `rowClass` marks it while a row is
  // dragged (is-dragging, is-drop-before, is-drop-after). A subtask shown under its parent has
  // no handle: its name cell takes that column too, so its indented check and title keep the
  // room they have without the handle (at 320px the name column is 88px wide).
  handleColumn = false,
  reorder = null,
  rowClass = '',
}) {
  const done = task.status === 'done'
  const columnIds = new Set(visibleColumns.map((c) => c.id))
  // Held until the refetch drops the completed row, so it never reappears between its fade and
  // its removal. Only a completion clicked here celebrates, and a rollback (done turns false)
  // ends it at once.
  const { celebrating, key: burstKey, celebrate } = useCelebration({ hold: true })
  const completing = celebrating && done

  const check = (
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
        flex: '0 0 auto',
        width: 44,
        height: 'var(--row)',
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
  )

  const nameText = phone
    ? {
        minWidth: 0,
        overflowWrap: 'anywhere',
        fontSize: '0.9375rem',
        color: done ? 'var(--t2)' : 'var(--t1)',
        textDecoration: done ? 'line-through' : 'none',
        overflow: 'hidden',
        // Two lines at most; the full name is the button's accessible name and the panel's title.
        // No padding here: inside an overflow-hidden line clamp, padding lets the top of the
        // third line show through. The button pads instead (.mytasks-title under 640px).
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
      }
    : {
        ...cellStyle,
        fontSize: '0.875rem',
        color: done ? 'var(--t2)' : 'var(--t1)',
        textDecoration: done ? 'line-through' : 'none',
      }

  // Right-click, Shift+F10, or the ContextMenu key on the row (TaskContextMenu.jsx).
  const { handlers: menuHandlers, menu: contextMenu } = useTaskContextMenu({
    label: `Actions for ${task.title}`,
    getItems: () => taskMenuItems({
      task,
      dueBounds,
      pending,
      onOpen,
      onToggleComplete,
      onUpdate: onQuickUpdate,
      projectOptions,
    }),
  })

  return (
    <>
    <div
      {...menuHandlers}
      className={`mytasks-grid mytasks-row${depth > 0 ? ' is-nested' : ''}${completing ? ' is-completing' : ''}${rowClass}`}
      data-task-id={depth === 0 ? task.id : undefined}
      data-subtask-id={depth > 0 ? task.id : undefined}
      onClick={() => onOpen(task.id)}
      style={{
        gridTemplateColumns,
        alignItems: 'center',
        minHeight: 'var(--row)',
        borderBottom: '1px solid var(--bd)',
        cursor: 'pointer',
        background: open ? 'var(--bg-selected)' : undefined,
        boxShadow: open ? 'inset 3px 0 0 var(--blue)' : undefined,
      }}
    >
      {handleColumn && depth === 0 && (reorder ? <ReorderHandle task={task} reorder={reorder} /> : <span aria-hidden="true" />)}
      {depth === 0 ? check : <span aria-hidden="true" />}

      {/* The name, then what follows it (Waiting, the subtask count), which never shrinks: a long
          name is shortened instead, whole in the row's accessible name and in the panel. */}
      <span className="mytasks-name" style={{ paddingRight: phone ? 0 : 12, gridColumn: handleColumn && depth > 0 ? '2 / span 2' : undefined }}>
        {depth > 0 && (
          <>
            {depth > 1 && <span aria-hidden="true" style={{ flex: '0 0 auto', width: (depth - 1) * 24 }} />}
            {check}
          </>
        )}
        {/* On a phone a name too long for its line takes the line, and what follows it wraps
            under it, rather than squeezing the name to a word or two. */}
        <span className="mytasks-name-body">
          <TitleCell task={task} nameText={nameText} disabled={pending} onRename={(title) => onQuickUpdate(task, { title })} />
          {(task.status === 'waiting' || subtaskCount > 0) && (
            <span className="mytasks-name-meta">
              {task.status === 'waiting' && (
                <span style={{ flex: '0 0 auto', fontSize: '0.75rem', color: 'var(--t2)' }}>Waiting</span>
              )}
              {subtaskCount > 0 && (
                <SubtaskToggle task={task} count={subtaskCount} expanded={expanded} onToggle={onToggleExpand} />
              )}
            </span>
          )}
          {/* Always shown, at the right end of the name (on a phone, on the name's first line, with
              Waiting and the count under it), so a long name still leaves a target that opens the panel. */}
          <button
            type="button"
            className="icon-btn mytasks-open"
            aria-label={`Open ${task.title}`}
            title="Open details"
            onClick={(e) => { e.stopPropagation(); onOpen(task.id) }}
          >
            <PanelRightOpen size={16} aria-hidden="true" />
          </button>
        </span>
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
    {contextMenu}
    </>
  )
}

// A task's open subtasks, from the list the view already loaded (each task carries its parentId),
// in their order on the parent: position, then creation.
export function indexSubtasks(tasks) {
  const byParent = new Map()
  for (const t of tasks) {
    if (!t.parentId) continue
    if (!byParent.has(t.parentId)) byParent.set(t.parentId, [])
    byParent.get(t.parentId).push(t)
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  }
  return byParent
}

// A row and, once its subtask count is pressed, its open subtasks as rows under it, as Asana's
// list shows them. A subtask keeps its own row in its own group as well; the ones shown here are
// the parent's, in the parent's order. Which rows are open is kept per row and not stored.
export function TaskTree({ task, depth = 0, subtasksByParent, projectNameById, pendingIds, openTaskId, reorder = null, rowClass = '', ...rowProps }) {
  const [expanded, setExpanded] = useState(false)
  const children = subtasksByParent?.get(task.id) || []
  const canExpand = children.length > 0 && depth < MAX_SUBTASK_DEPTH
  return (
    <>
      {/* The handle and the drag marks are the top row's alone; its subtasks move with it. */}
      <TaskRow
        {...rowProps}
        reorder={reorder}
        rowClass={rowClass}
        task={task}
        depth={depth}
        projectName={projectNameById.get(task.projectId)}
        pending={pendingIds.has(task.id)}
        open={task.id === openTaskId}
        subtaskCount={children.length}
        expanded={canExpand && expanded}
        onToggleExpand={canExpand ? () => setExpanded((v) => !v) : undefined}
      />
      {canExpand && expanded && children.map((child) => (
        <TaskTree
          key={child.id}
          {...rowProps}
          task={child}
          depth={depth + 1}
          subtasksByParent={subtasksByParent}
          projectNameById={projectNameById}
          pendingIds={pendingIds}
          openTaskId={openTaskId}
        />
      ))}
    </>
  )
}
