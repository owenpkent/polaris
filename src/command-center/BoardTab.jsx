import { useId, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronRight, FolderKanban, Plus, Repeat } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import NotConnected from './NotConnected'
import TaskDetailPanel from './TaskDetailPanel'
import { Loading, EmptyState, ErrorBanner, Avatar } from './shared'
import { formatDueCell, getDueBounds, plainTitle, repeatLabel } from './dueDates'
import CompleteBurst, { completeExitDelay, useCelebration } from './CompleteBurst'
import { oneLine, useFitToText } from './useFitToText'
import { Popover } from './Menu'
import { useRequestGuard } from './useRequestGuard'

const NO_SECTION = '__no_section__'
const BOARD_PROJECT_KEY = 'cc-board-project-v1'

// Open on the last project picked here, else the one with the most open tasks.
function defaultBoardProject(projects) {
  let remembered = null
  try { remembered = localStorage.getItem(BOARD_PROJECT_KEY) } catch { /* storage unavailable */ }
  if (remembered && projects.some((p) => p.id === remembered)) return remembered
  const busiest = [...projects].sort((a, b) => (b.counts?.open || 0) - (a.counts?.open || 0))[0]
  return busiest?.id || ''
}

function rememberBoardProject(id) {
  try { localStorage.setItem(BOARD_PROJECT_KEY, id) } catch { /* storage unavailable */ }
}

// Priority is a soft pill on the card, as in the list (.priority-pill in index.css);
// none/medium (the default) render nothing.
const PRIORITY_META = {
  low: { label: 'Low', className: 'badge priority-pill is-low' },
  high: { label: 'High', className: 'badge priority-pill is-high' },
  urgent: { label: 'Urgent', className: 'badge priority-pill is-urgent' },
}

function sectionKey(task) {
  return task.sectionId || NO_SECTION
}

// Dropdown that opens below-right of a card's move button. `destinations` is
// the full list of board columns (real sections plus the synthetic "No
// section" one) in display order; the one matching the task's current
// section renders as a disabled row with a check mark instead of a button.
function MoveMenu({ task, destinations, onMove, onClose, anchorRef }) {
  const itemRefs = useRef([])

  function handleKeyDown(e) {
    const items = itemRefs.current.filter(Boolean)
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length].focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length].focus()
    } else if (e.key === 'Tab') {
      onClose()
    }
  }

  const current = sectionKey(task)
  itemRefs.current = []

  return (
    <Popover anchorRef={anchorRef} open onClose={onClose} align="end" minWidth={220} focusSelector="[role='menuitem']:not([aria-disabled])">
      <div role="menu" aria-label={`Move ${task.title}`} onKeyDown={handleKeyDown}>
      <div style={{ padding: '6px 14px 4px', fontSize: 12, color: 'var(--t2)' }}>Move to</div>
      {destinations.map((section) => {
        if (section.id === current) {
          return (
            <div
              key={section.id}
              role="menuitem"
              aria-disabled="true"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                minHeight: 44,
                padding: '0 14px',
                fontSize: 14,
                color: 'var(--t2)',
              }}
            >
              <span>{section.name}</span>
              <Check size={16} aria-hidden="true" />
            </div>
          )
        }
        return (
          <button
            key={section.id}
            type="button"
            role="menuitem"
            ref={(el) => { if (el) itemRefs.current.push(el) }}
            onClick={() => { onMove(task, section.id === NO_SECTION ? null : section.id); onClose() }}
            style={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              minHeight: 44,
              padding: '0 14px',
              fontSize: 14,
              color: 'var(--t1)',
              background: 'transparent',
              border: 'none',
              textAlign: 'left',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            {section.name}
          </button>
        )
      })}
      </div>
    </Popover>
  )
}

// The check circle before a card's title: the list's (TaskRow.jsx), with the same celebration
// (CompleteBurst.jsx) and the same classes, so a task completes the same way wherever it is.
function CardCheck({ task, pending, completing, burstKey, onToggle }) {
  const done = task.status === 'done'
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
      disabled={pending}
      className="task-check board-card-check"
      onClick={onToggle}
      // The check keeps its full colour while it celebrates, though the request is pending.
      style={{ cursor: pending ? 'default' : 'pointer', opacity: pending && !completing ? 0.6 : 1 }}
    >
      {/* The tick is drawn but transparent until the task is done or the button is hovered. */}
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
}

// A card as Asana draws one: the check circle, the title, the priority pill, and a foot with the
// assignee and the due date in the list's words and colours (formatDueCell). The card face opens
// the task, and the arrow at the top right moves it to another lane, so nothing needs a drag.
function BoardCard({ task, dueBounds, pending, onToggleComplete, destinations, onMove, onOpen, menuOpen, onToggleMenu, onCloseMenu }) {
  const done = task.status === 'done'
  const priority = PRIORITY_META[task.priority]
  const due = formatDueCell(task.dueAt, dueBounds)
  const repeat = repeatLabel(task.recurrence)
  const hasFoot = Boolean(due.text || repeat || task.assignee)
  const anchorRef = useRef(null)
  // Held until the refetch drops the card into its lane's done list, as a list row is held.
  const { celebrating, key: burstKey, celebrate } = useCelebration({ hold: true })
  const completing = celebrating && done

  const classes = ['board-card']
  if (menuOpen) classes.push('is-menu-open')
  if (completing) classes.push('is-completing')

  return (
    <div style={{ position: 'relative' }}>
      <div className={classes.join(' ')} data-task-id={task.id}>
        <CardCheck
          task={task}
          pending={pending}
          completing={completing}
          burstKey={burstKey}
          onToggle={() => {
            if (!done) celebrate()
            onToggleComplete(task)
          }}
        />

        <button type="button" className="board-card-open" onClick={() => onOpen(task.id)}>
          <span
            className="board-card-title"
            style={{ color: done ? 'var(--t2)' : 'var(--t1)', textDecoration: done ? 'line-through' : 'none' }}
          >
            {plainTitle(task.title)}
          </span>
          {priority && (
            <span className="board-card-chips">
              <span className={priority.className}>{priority.label}</span>
            </span>
          )}
          {hasFoot && (
            <span className="board-card-foot">
              {task.assignee && (
                // The initials stand for the name here; the panel spells it out.
                <span style={{ display: 'inline-flex' }} title={task.assignee}>
                  <Avatar name={task.assignee} size={22} />
                </span>
              )}
              {due.text && <span style={{ color: due.color || 'var(--t2)' }}>{due.text}</span>}
              {repeat && <Repeat size={12} aria-hidden="true" className="repeat-glyph" />}
            </span>
          )}
        </button>

        <button
          type="button"
          ref={anchorRef}
          className="board-card-move"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Move ${task.title}`}
          onClick={() => onToggleMenu(task.id)}
        >
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      </div>

      {menuOpen && (
        <MoveMenu task={task} destinations={destinations} onMove={onMove} anchorRef={anchorRef} onClose={onCloseMenu} />
      )}
    </div>
  )
}

// "Add task" in a lane, as Asana's board has it: a quiet row that opens a blank card in place.
// Enter or the Add task button saves it into this lane's section and leaves a fresh card open for
// the next one; Esc or Cancel, or leaving the card empty, closes it. A create is queued offline
// like any task edit (outbox.js), so this stays on with the server away, as the list's Add task does.
function LaneAddTask({ section, onCreate }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const openerRef = useRef(null)
  const formRef = useRef(null)
  const reopenFocus = useRef(false)
  const mounted = useRef(true)
  const fitRef = useFitToText(title, inputRef)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else if (reopenFocus.current) {
      reopenFocus.current = false
      openerRef.current?.focus()
    }
  }, [open])

  // Whether a pointer is pressed while the card is open, so a click elsewhere that takes focus
  // from an empty card waits for the release before the card closes: closing on the press would
  // swap the tall card for the short Add task row and move what is under it (the lane's Show done)
  // up before the release, which would then land on whatever moved under the pointer instead.
  const pointerDown = useRef(false)
  useEffect(() => {
    if (!open) return undefined
    const down = () => { pointerDown.current = true }
    const up = () => { pointerDown.current = false }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      pointerDown.current = false
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
    }
  }, [open])

  function close({ focusOpener = false } = {}) {
    reopenFocus.current = focusOpener
    setOpen(false)
    setTitle('')
    setError(null)
  }

  function closeIfLeftEmpty() {
    const input = inputRef.current
    if (!mounted.current || !input || input.value.trim() || formRef.current?.contains(document.activeElement)) return
    close()
  }

  function handleBlur(e) {
    // Leaving an empty card closes it, unless focus went to one of its own buttons.
    if (title.trim() || busy || formRef.current?.contains(e.relatedTarget)) return
    if (!pointerDown.current) {
      close()
      return
    }
    // After the release and the click it makes, which run in the same task as pointerup.
    window.addEventListener('pointerup', () => setTimeout(closeIfLeftEmpty, 0), { once: true, capture: true })
  }

  async function submit() {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmed, section.id === NO_SECTION ? null : section.id)
      if (!mounted.current) return
      setTitle('')
    } catch (err) {
      if (!mounted.current) return
      setError(err.message || 'Could not add task.')
    }
    setBusy(false)
    inputRef.current?.focus()
  }

  if (!open) {
    return (
      <button type="button" ref={openerRef} className="board-add-task" aria-label={`Add task to ${section.name}`} onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden="true" />
        <span>Add task</span>
      </button>
    )
  }

  return (
    <div ref={formRef} className="board-card board-add-card" onBlur={handleBlur}>
      <textarea
        ref={fitRef}
        rows={1}
        className="board-add-title"
        value={title}
        onChange={(e) => setTitle(oneLine(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close({ focusOpener: true })
          }
        }}
        readOnly={busy}
        placeholder="Write a task name"
        aria-label={`New task in ${section.name}`}
      />
      {error && <div role="alert" className="board-add-error">{error}</div>}
      <div className="board-add-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !title.trim()} onClick={submit}>Add task</button>
        <button type="button" className="btn-ghost" onClick={() => close({ focusOpener: true })}>Cancel</button>
      </div>
    </div>
  )
}

function Column({ section, tasks, destinations, dueBounds, pendingIds, exitingIds, openMoveId, onToggleMenu, onCloseMenu, onMove, onOpen, onToggleComplete, onCreate }) {
  const [showDone, setShowDone] = useState(false)
  // A card being completed stays among the open ones until its celebration ends.
  const active = tasks.filter((t) => t.status !== 'done' || exitingIds.has(t.id))
  const done = tasks.filter((t) => t.status === 'done' && !exitingIds.has(t.id))
  const titleId = useId()

  const cardProps = (task) => ({
    task,
    dueBounds,
    pending: pendingIds.has(task.id),
    onToggleComplete,
    destinations,
    onMove,
    onOpen,
    menuOpen: openMoveId === task.id,
    onToggleMenu,
    onCloseMenu,
  })

  // A labelled region, so a screen reader (and the UI tests) can address a lane by its name.
  return (
    <section aria-labelledby={titleId} className="board-lane">
      <div className="board-lane-head">
        <h2 id={titleId} className="board-lane-title">{section.name}</h2>
        <div className="board-lane-count">{tasks.length}</div>
      </div>

      {active.map((task) => <BoardCard key={task.id} {...cardProps(task)} />)}

      {/* At the top of an empty lane and under the last open card otherwise, as in Asana. */}
      <LaneAddTask section={section} onCreate={onCreate} />

      {done.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minHeight: 44,
              width: '100%',
              padding: '0 14px',
              borderRadius: 'var(--radius)',
              border: showDone ? 'none' : '1px dashed var(--bd)',
              background: 'transparent',
              color: 'var(--t2)',
              fontSize: 14,
            }}
          >
            {showDone ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            <span>{showDone ? 'Hide done' : `Show ${done.length} done`}</span>
          </button>
          {showDone && done.map((task) => <BoardCard key={task.id} {...cardProps(task)} />)}
        </>
      )}
    </section>
  )
}

const without = (set, id) => {
  const next = new Set(set)
  next.delete(id)
  return next
}

// `projectId`, when set, is the project the sidebar asked for (App.jsx): it replaces the remembered
// choice. `onProjectChange` reports whichever project the board ends up showing, so the sidebar
// can mark it.
export default function BoardTab({ projectId = null, onProjectChange }) {
  const { connected, api } = useConnection()
  const [projects, setProjects] = useState([])
  const [projectRef, setProjectRef] = useState('')

  useEffect(() => {
    if (!projectId) return
    setProjectRef(projectId)
    rememberBoardProject(projectId)
  }, [projectId])

  useEffect(() => {
    if (projectRef) onProjectChange?.(projectRef)
  }, [projectRef, onProjectChange])
  const [board, setBoard] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [detailTaskId, setDetailTaskId] = useState(null)
  const [openMoveId, setOpenMoveId] = useState(null)
  // Cards whose complete or reopen is on its way, and completed cards still celebrating in place.
  const [pendingIds, setPendingIds] = useState(() => new Set())
  const [exitingIds, setExitingIds] = useState(() => new Set())

  useEffect(() => {
    if (!connected) return
    api.listProjects().then((res) => {
      const list = res.projects || []
      setProjects(list)
      setProjectRef((prev) => prev || defaultBoardProject(list))
    }).catch((err) => setError(err.message || 'Could not load projects.'))
  }, [connected, api])

  const beginRequest = useRequestGuard()
  const fetchBoard = useCallback(async () => {
    if (!projectRef) return
    const isCurrent = beginRequest()
    setError(null)
    try {
      const res = await api.getProject(projectRef)
      if (isCurrent()) setBoard(res)
    } catch (err) {
      if (isCurrent()) setError(err.message || 'Could not load this project.')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [api, projectRef, beginRequest])

  useEffect(() => {
    if (!connected || !projectRef) return
    setLoading(true)
    fetchBoard()
  }, [connected, projectRef, fetchBoard])

  useEventRefresh(fetchBoard, { enabled: connected && Boolean(projectRef) })

  // The project on screen now, for a complete or a create whose request outlives a switch to
  // another project: the refresh it ends with is for the project it started in, so it is dropped
  // unless that project is still the one selected. Otherwise it would load the old project's lanes
  // over the new one's while the selector still named the new one.
  const selectedRef = useRef(projectRef)
  useEffect(() => { selectedRef.current = projectRef }, [projectRef])
  const refreshIfShown = useCallback(async (pid) => {
    if (selectedRef.current === pid) await fetchBoard()
  }, [fetchBoard])

  const columns = useMemo(() => {
    if (!board) return []
    const sections = board.sections || []
    const byId = new Map(sections.map((s) => [s.id, []]))
    const noSection = []
    ;(board.tasks || []).forEach((t) => {
      if (t.sectionId && byId.has(t.sectionId)) byId.get(t.sectionId).push(t)
      else noSection.push(t)
    })
    return [
      ...sections.map((s) => ({ section: s, tasks: byId.get(s.id) || [] })),
      { section: { id: NO_SECTION, name: 'No section' }, tasks: noSection },
    ]
  }, [board])

  // Every column is a valid move target, including the synthetic "No
  // section" one -- this mirrors what the board already shows.
  const destinations = useMemo(() => columns.map((c) => c.section), [columns])

  const handleMove = useCallback(async (task, sectionId) => {
    const prevBoard = board
    // Optimistic move within the local board state.
    setBoard((b) => (b ? { ...b, tasks: b.tasks.map((t) => (t.id === task.id ? { ...t, sectionId } : t)) } : b))
    try {
      // sectionId is a real id or null ("No section"); send it as-is. The
      // move endpoint's body schema is strict and treats an omitted key
      // differently from an explicit null, so `sectionId || undefined`
      // would silently fail to clear a section.
      await api.moveTask(task.id, { section: sectionId })
    } catch (err) {
      setBoard(prevBoard)
      setError(err.message || 'Could not move that task.')
    }
  }, [api, board])

  // The list's completion (MyTasksTab.jsx): flip the card at once, keep a completed card in its
  // place while the check celebrates, then refetch, which files it under the lane's done toggle.
  const setTaskStatus = useCallback((id, status) => {
    setBoard((b) => (b ? { ...b, tasks: b.tasks.map((t) => (t.id === id ? { ...t, status } : t)) } : b))
  }, [])

  const handleToggleComplete = useCallback(async (task) => {
    const wasDone = task.status === 'done'
    const pid = projectRef
    setError(null)
    setPendingIds((prev) => new Set(prev).add(task.id))
    if (!wasDone) setExitingIds((prev) => new Set(prev).add(task.id))
    setTaskStatus(task.id, wasDone ? 'open' : 'done')
    try {
      if (wasDone) {
        await api.reopenTask(task.id)
      } else {
        const exit = new Promise((resolve) => setTimeout(resolve, completeExitDelay()))
        await api.completeTask(task.id)
        await exit
      }
      await refreshIfShown(pid)
    } catch (err) {
      setTaskStatus(task.id, task.status)
      setError(err.message || 'Could not update that task.')
    } finally {
      setPendingIds((prev) => without(prev, task.id))
      setExitingIds((prev) => without(prev, task.id))
    }
  }, [api, projectRef, refreshIfShown, setTaskStatus])

  // A new task from a lane's Add task: the selected project, that lane's section (null for No
  // section). The project is read when the card is submitted, never from a board that may still be
  // the last project's while the next one loads.
  const handleCreate = useCallback(async (title, sectionId) => {
    const pid = projectRef
    await api.createTask({ title, projectId: pid, sectionId })
    await refreshIfShown(pid)
  }, [api, projectRef, refreshIfShown])

  const handleToggleMenu = useCallback((taskId) => {
    setOpenMoveId((prev) => (prev === taskId ? null : taskId))
  }, [])

  const handleCloseMenu = useCallback(() => setOpenMoveId(null), [])

  if (!connected) return <NotConnected />

  const dueBounds = getDueBounds()

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 72 }}>
        <div style={{ position: 'relative', display: 'inline-flex', minWidth: 0, maxWidth: '100%' }}>
          <select
            id="board-project"
            aria-label="Project"
            value={projectRef}
            onChange={(e) => { setProjectRef(e.target.value); rememberBoardProject(e.target.value) }}
            style={{
              appearance: 'none',
              WebkitAppearance: 'none',
              MozAppearance: 'none',
              height: 44,
              // A native select is as wide as its longest option; a long project name would
              // otherwise push the page sideways, so it stops at the row's width (and 220px is less than
              // the narrowest phone's row). The open list shows every name in full.
              minWidth: 220,
              maxWidth: '100%',
              textOverflow: 'ellipsis',
              padding: '0 36px 0 14px',
              border: '1px solid var(--bd-strong)',
              borderRadius: 'var(--radius)',
              background: 'var(--bg2)',
              color: 'var(--t1)',
              fontSize: 14,
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <ChevronDown
            size={16}
            aria-hidden="true"
            style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--t2)' }}
          />
        </div>
      </div>

      <ErrorBanner message={error} onRetry={fetchBoard} />

      {!projectRef ? (
        <EmptyState icon={FolderKanban} title="No projects yet" hint="Projects will appear here once they exist on the server." />
      ) : loading ? (
        <Loading label="Loading board…" />
      ) : (
        <div className="board-lanes">
          {columns.map(({ section, tasks }) => (
            <Column
              key={section.id}
              section={section}
              tasks={tasks}
              destinations={destinations}
              dueBounds={dueBounds}
              pendingIds={pendingIds}
              exitingIds={exitingIds}
              openMoveId={openMoveId}
              onToggleMenu={handleToggleMenu}
              onCloseMenu={handleCloseMenu}
              onMove={handleMove}
              onOpen={setDetailTaskId}
              onToggleComplete={handleToggleComplete}
              onCreate={handleCreate}
            />
          ))}
        </div>
      )}

      {detailTaskId && (
        <TaskDetailPanel
          taskId={detailTaskId}
          onClose={() => setDetailTaskId(null)}
          onChanged={fetchBoard}
          onOpenTask={setDetailTaskId}
        />
      )}
    </div>
  )
}
