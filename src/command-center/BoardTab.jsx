import { useId, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronRight, FolderKanban } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import NotConnected from './NotConnected'
import TaskDetailPanel from './TaskDetailPanel'
import { Loading, EmptyState, ErrorBanner, formatDate, isOverdue } from './shared'
import { plainTitle } from './dueDates'
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

// Priority is shown as plain colored text in the card meta row; none/medium
// (the default) render nothing, matching the approved mockup.
const PRIORITY_META = {
  low: { label: 'Low', color: 'var(--t2)' },
  high: { label: 'High', color: 'var(--orange)' },
  urgent: { label: 'Urgent', color: 'var(--red)' },
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

function BoardCard({ task, destinations, onMove, onOpen, menuOpen, onToggleMenu, onCloseMenu }) {
  const overdue = isOverdue(task)
  const priority = PRIORITY_META[task.priority]
  const hasMeta = Boolean(task.dueAt || priority)
  const anchorRef = useRef(null)
  const [hovered, setHovered] = useState(false)

  return (
    <div style={{ position: 'relative' }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 44px',
          alignItems: 'start',
          gap: 4,
          padding: '12px 6px 12px 14px',
          background: hovered ? 'var(--bg3)' : 'var(--bg2)',
          border: `1px solid ${menuOpen ? 'var(--blue)' : 'var(--bd-surface)'}`,
          borderRadius: 'var(--radius-lg)',
          boxShadow: hovered ? 'var(--shadow-2)' : 'var(--shadow-1)',
          transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
        }}
      >
        <button
          type="button"
          onClick={() => onOpen(task.id)}
          style={{
            display: 'block',
            // The button takes over the card's top, bottom, and left padding (negative margin,
            // equal padding), so the whole card face is the click target. Without this a card
            // with no due date or priority is a single 22px line, under the 44px minimum.
            width: 'calc(100% + 14px)',
            minWidth: 0,
            minHeight: 'var(--target)',
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius)',
            padding: '12px 0 12px 14px',
            margin: '-12px 0 -12px -14px',
            font: 'inherit',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          <div className="board-card-title" style={{ fontSize: 14, lineHeight: 1.4, color: 'var(--t1)', paddingTop: 2 }}>{plainTitle(task.title)}</div>
          {hasMeta && (
            <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 13, color: 'var(--t2)' }}>
              {task.dueAt && (
                <span style={{ color: overdue ? 'var(--red)' : 'var(--t2)' }}>{formatDate(task.dueAt)}</span>
              )}
              {priority && <span style={{ color: priority.color }}>{priority.label}</span>}
            </div>
          )}
        </button>

        <button
          type="button"
          ref={anchorRef}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Move ${task.title}`}
          onClick={() => onToggleMenu(task.id)}
          style={{
            width: 44,
            height: 44,
            marginTop: -8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 8,
            color: menuOpen ? 'var(--t1)' : 'var(--t2)',
            background: menuOpen ? 'var(--bg3)' : 'transparent',
            border: 'none',
          }}
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

function Column({ section, tasks, destinations, openMoveId, onToggleMenu, onCloseMenu, onMove, onOpen }) {
  const [showDone, setShowDone] = useState(false)
  const active = tasks.filter((t) => t.status !== 'done')
  const done = tasks.filter((t) => t.status === 'done')
  const titleId = useId()

  // A labelled region, so a screen reader (and the UI tests) can address a lane by its name.
  return (
    <section
      aria-labelledby={titleId}
      className="board-lane"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '4px 10px 10px',
        background: 'var(--bg-inset)',
        border: '1px solid var(--lane-edge)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lane)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 4px' }}>
        <h2 id={titleId} className="board-lane-title" style={{ fontSize: 15, fontWeight: 600, color: 'var(--t1)' }}>{section.name}</h2>
        <div style={{ fontSize: 13, color: 'var(--t2)' }}>{tasks.length}</div>
      </div>

      {tasks.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--t2)', padding: '8px 0' }}>No tasks</div>
      )}

      {active.map((task) => (
        <BoardCard
          key={task.id}
          task={task}
          destinations={destinations}
          onMove={onMove}
          onOpen={onOpen}
          menuOpen={openMoveId === task.id}
          onToggleMenu={onToggleMenu}
          onCloseMenu={onCloseMenu}
        />
      ))}

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
          {showDone && done.map((task) => (
            <BoardCard
              key={task.id}
              task={task}
              destinations={destinations}
              onMove={onMove}
              onOpen={onOpen}
              menuOpen={openMoveId === task.id}
              onToggleMenu={onToggleMenu}
              onCloseMenu={onCloseMenu}
            />
          ))}
        </>
      )}
    </section>
  )
}

export default function BoardTab() {
  const { connected, api } = useConnection()
  const [projects, setProjects] = useState([])
  const [projectRef, setProjectRef] = useState('')
  const [board, setBoard] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [detailTaskId, setDetailTaskId] = useState(null)
  const [openMoveId, setOpenMoveId] = useState(null)

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

  const handleToggleMenu = useCallback((taskId) => {
    setOpenMoveId((prev) => (prev === taskId ? null : taskId))
  }, [])

  const handleCloseMenu = useCallback(() => setOpenMoveId(null), [])

  if (!connected) return <NotConnected />

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 72 }}>
        <div style={{ position: 'relative', display: 'inline-flex' }}>
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
              minWidth: 220,
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
              openMoveId={openMoveId}
              onToggleMenu={handleToggleMenu}
              onCloseMenu={handleCloseMenu}
              onMove={handleMove}
              onOpen={setDetailTaskId}
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
