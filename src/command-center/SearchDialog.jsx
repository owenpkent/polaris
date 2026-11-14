import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { MY_TASKS_QUERY } from './api'
import { useOffline } from './offlineStatus'
import { formatDueCell, getDueBounds, plainTitle } from './dueDates'
import DueChip from './DueChip'
import { STATUS_LABELS } from './shared'

// What the search covers: the tasks the owner works from, and the ones already done. An inbox
// item is a proposal that is dealt with on the Inbox page, not in a task panel, and a dropped
// task is gone.
const SEARCH_STATUSES = 'open,in_progress,waiting,done'
// The most results one search lists. A search that fills it says so, and a longer word narrows it.
export const SEARCH_LIMIT = 50
const MIN_LETTERS = 2

function matches(task, query) {
  const q = query.toLowerCase()
  return (task.title || '').toLowerCase().includes(q) || (task.notes || '').toLowerCase().includes(q)
}

// The server searches titles and notes (GET /api/tasks?text=). With no server in reach a text
// search has no stored answer, because api.js keeps none, so the copy of My tasks is searched
// here instead: open tasks only, which the dialog says.
export async function searchTasks(api, query, offline) {
  if (!offline) {
    try {
      const res = await api.listTasks({ text: query, status: SEARCH_STATUSES, orderBy: 'updated', limit: SEARCH_LIMIT })
      return { tasks: res.tasks || [], fromCopy: false }
    } catch (err) {
      if (err?.code !== 'network_error' && err?.code !== 'not_connected') throw err
    }
  }
  const res = await api.listTasks(MY_TASKS_QUERY)
  return { tasks: (res.tasks || []).filter((task) => matches(task, query)).slice(0, SEARCH_LIMIT), fromCopy: true }
}

// Tasks still to do come first, in the order the server gave them, then the ones done.
function activeFirst(tasks) {
  return [...tasks.filter((task) => task.status !== 'done'), ...tasks.filter((task) => task.status === 'done')]
}

const IDLE = { phase: 'idle', tasks: [], fromCopy: false, error: null }

// Finds a task by a word from its title or notes, from any view (the top bar's Search button, or
// `/`). Choosing a result hands its id to `onOpenTask`, which opens that task's panel on My tasks.
// Nothing here writes, so it works with the server out of reach.
export default function SearchDialog({ onClose, onOpenTask }) {
  const { api } = useConnection()
  const offline = useOffline()
  const [text, setText] = useState('')
  const [found, setFound] = useState(IDLE)
  const [projectNames, setProjectNames] = useState({})
  const dialogRef = useRef(null)
  const inputRef = useRef(null)
  const query = text.trim()

  useEffect(() => { inputRef.current?.focus() }, [])

  // Project names for the line under each result. A search still works without them.
  useEffect(() => {
    let cancelled = false
    api.listProjects({ includeArchived: true })
      .then((res) => {
        if (cancelled) return
        setProjectNames(Object.fromEntries((res?.projects || []).map((project) => [project.id, project.name])))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [api])

  useEffect(() => {
    if (query.length < MIN_LETTERS) {
      setFound(IDLE)
      return undefined
    }
    let cancelled = false
    setFound((current) => ({ ...current, phase: 'searching', error: null }))
    const timer = setTimeout(async () => {
      try {
        const res = await searchTasks(api, query, offline)
        if (!cancelled) setFound({ phase: 'done', tasks: activeFirst(res.tasks), fromCopy: res.fromCopy, error: null })
      } catch (err) {
        if (!cancelled) setFound({ phase: 'error', tasks: [], fromCopy: false, error: err.message || 'Could not search.' })
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, api, offline])

  // Esc closes, and Tab stays inside. The listener runs before any view's own (a task panel open
  // underneath has an Esc and a Tab trap too) and keeps the key from reaching them.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      e.stopPropagation()
      const focusables = dialogRef.current ? Array.from(dialogRef.current.querySelectorAll('input, button')) : []
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !dialogRef.current.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const count = found.tasks.length
  const bounds = getDueBounds()
  let status = 'Type two or more letters from the title or notes of a task.'
  if (found.phase === 'searching') status = 'Searching…'
  else if (found.phase === 'error') status = found.error
  else if (found.phase === 'done') {
    const parts = [count === 0 ? 'No tasks match.' : count === 1 ? '1 task.' : `${count} tasks.`]
    if (count >= SEARCH_LIMIT) parts.push(`These are the first ${SEARCH_LIMIT}: a longer word narrows it.`)
    if (found.fromCopy) parts.push('The server is out of reach, so only open tasks were searched.')
    status = parts.join(' ')
  }

  return (
    <div className="modal-backdrop search-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialogRef} className="modal search-modal" role="dialog" aria-modal="true" aria-label="Search tasks">
        <div className="search-head">
          <Search size={20} aria-hidden="true" style={{ color: 'var(--t2)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            aria-label="Search tasks"
            placeholder="Search tasks"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="button" className="icon-btn" aria-label="Close search" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <p className="search-status" role="status" style={found.phase === 'error' ? { color: 'var(--red)' } : undefined}>{status}</p>
        {count > 0 && (
          <div className="surface flush-last goal-list search-results">
            {found.tasks.map((task) => {
              const meta = [
                task.status === 'done' ? STATUS_LABELS.done : null,
                projectNames[task.projectId] || null,
              ].filter(Boolean)
              // The date is a chip at the result's right, in the words and colours of My tasks,
              // so the dates of a list of results line up as a column.
              const due = formatDueCell(task.dueAt, bounds)
              return (
                <button
                  key={task.id}
                  type="button"
                  className="goal-list-row hover-surface search-row"
                  onClick={() => onOpenTask(task.id)}
                >
                  <span className="search-row-text">
                    <span>{plainTitle(task.title)}</span>
                    {meta.length > 0 && <span className="search-row-meta">{meta.join(' · ')}</span>}
                  </span>
                  {/* Heard as part of the result's name, as the words under the title were. */}
                  {due.text && <span className="sr-only">, due </span>}
                  <DueChip due={due} />
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
