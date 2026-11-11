import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Target, X } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { useOffline } from './offlineStatus'
import NotConnected from './NotConnected'
import { Menu } from './Menu'
import { ConfirmButton, EmptyState, ErrorBanner, Loading, todayIso } from './shared'
import { formatDueShort, plainTitle } from './dueDates'
import {
  GOAL_STATUS_OPTIONS, flattenGoalTree, goalFlags, importAlreadyDone, markImportDone, periodSuggestions,
  progressLabel, readLegacyGoals, statusOption,
} from './goalsModel'
import { useRequestGuard } from './useRequestGuard'

// Goals live in the Command Center (initiatives/teammates-and-goals.md). Status is always set
// here by hand; progress is counted from linked work or typed in. Every control is a click:
// typing is only needed for a title, a note, or a number.

function getStorage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function StatusButton({ goal, onChange }) {
  const offline = useOffline()
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const current = statusOption(goal.status)
  const items = GOAL_STATUS_OPTIONS.map((opt) => ({
    key: opt.value,
    label: opt.label,
    checked: goal.status === opt.value,
    onSelect: () => onChange(goal, { status: opt.value }),
  }))
  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        className="btn goal-status-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Status of ${goal.title}: ${current.label}`}
        disabled={offline}
        onClick={() => setOpen((v) => !v)}
        style={{ color: current.color, background: current.soft, borderColor: current.color }}
      >
        {current.label}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <Menu anchorRef={btnRef} open={open} onClose={() => setOpen(false)} items={items} label={`Status for ${goal.title}`} minWidth={170} />
    </div>
  )
}

function ProgressBar({ goal }) {
  const percent = goal.progress?.percent
  return (
    <div className="goal-progress">
      <div
        className="progress-bar"
        role="progressbar"
        aria-label={`Progress of ${goal.title}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? 0}
        aria-valuetext={progressLabel(goal)}
      >
        <div className="progress-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <span className="goal-progress-text">{progressLabel(goal)}</span>
    </div>
  )
}

function AddGoalForm({ parent, onCreate, onCancel }) {
  const offline = useOffline()
  const suggestions = useMemo(() => periodSuggestions(), [])
  const [title, setTitle] = useState('')
  const [period, setPeriod] = useState(suggestions[0])
  const [manual, setManual] = useState(false)
  const [target, setTarget] = useState('')
  const [unit, setUnit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const label = parent ? `New sub-goal of ${parent.title}` : 'New goal'

  const submit = async (e) => {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const payload = { title: title.trim(), parentId: parent?.id }
      if (period) Object.assign(payload, { periodLabel: period.label, startsOn: period.startsOn, endsOn: period.endsOn })
      if (manual) {
        payload.progressMode = 'manual'
        payload.currentValue = 0
        if (target !== '' && Number.isFinite(Number(target))) payload.targetValue = Number(target)
        if (unit.trim()) payload.unit = unit.trim()
      }
      await onCreate(payload)
    } catch (err) {
      setError(err.message || 'Could not create that goal.')
      setBusy(false)
    }
  }

  return (
    <form
      className="surface goal-form"
      aria-label={label}
      onSubmit={submit}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}
    >
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="goal-new-title">{label}</label>
        <input id="goal-new-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="What do you want to be true?" style={{ minHeight: 44, padding: '0 12px' }} />
      </div>

      <div role="group" aria-label="Period" className="goal-choice-row">
        {suggestions.map((s) => (
          <button key={s.label} type="button" className="btn" aria-pressed={period?.label === s.label} onClick={() => setPeriod(s)}>
            {s.label}
          </button>
        ))}
        <button type="button" className="btn" aria-pressed={period === null} onClick={() => setPeriod(null)}>No period</button>
      </div>

      <div role="group" aria-label="How progress is measured" className="goal-choice-row">
        <button type="button" className="btn" aria-pressed={!manual} onClick={() => setManual(false)}>Count linked tasks</button>
        <button type="button" className="btn" aria-pressed={manual} onClick={() => setManual(true)}>Type in a number</button>
      </div>

      {manual && (
        <div className="goal-manual-fields">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="goal-new-target">Target</label>
            <input id="goal-new-target" type="number" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} style={{ minHeight: 44, padding: '0 12px' }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="goal-new-unit">Unit</label>
            <input id="goal-new-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="subscribers" style={{ minHeight: 44, padding: '0 12px' }} />
          </div>
        </div>
      )}

      {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 14 }}>{error}</div>}

      <div className="goal-choice-row">
        <button type="submit" className="btn btn-primary" disabled={!title.trim() || busy || offline}>{parent ? 'Add sub-goal' : 'Add goal'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function TaskSearch({ goal, api, onLinked }) {
  const offline = useOffline()
  const [text, setText] = useState('')
  const [results, setResults] = useState([])

  useEffect(() => {
    const query = text.trim()
    if (query.length < 2) {
      setResults([])
      return undefined
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const res = await api.listTasks({ text: query, status: 'open,in_progress,waiting', limit: 8 })
        if (!cancelled) setResults(res.tasks || [])
      } catch {
        if (!cancelled) setResults([])
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, api])

  return (
    <div>
      <div className="field" style={{ marginBottom: 8 }}>
        <label htmlFor={`goal-task-search-${goal.id}`}>Link a task</label>
        <input
          id={`goal-task-search-${goal.id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type part of a task name"
          disabled={offline}
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </div>
      {results.length > 0 && (
        <div className="surface flush-last goal-list">
          {results.map((task) => (
            <button
              key={task.id}
              type="button"
              className="goal-list-row hover-surface"
              aria-label={`Link task ${task.title}`}
              disabled={offline}
              onClick={async () => {
                await onLinked({ taskId: task.id })
                setText('')
              }}
            >
              {plainTitle(task.title)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function GoalDetails({ goal, api, projects, onUpdate, onChanged, onAddSub, onDelete }) {
  const offline = useOffline()
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [title, setTitle] = useState(goal.title)
  const [note, setNote] = useState(goal.statusNote || '')
  const [current, setCurrent] = useState(goal.currentValue ?? '')
  const [target, setTarget] = useState(goal.targetValue ?? '')

  // These are copies of server values, so they have to follow the server. The panel stays open
  // while the 10s poll refreshes underneath it, and a goal can change from the CLI or from Claude
  // Code over MCP. Without this the fields kept the values they had at mount, the Save buttons
  // un-disabled themselves because the draft no longer matched the new value, and one click wrote
  // the stale text back over the newer one. A field that holds an unsaved edit is left alone, so a
  // poll never overwrites what the owner is typing (see "Leaving an edit" in CONTRIBUTING.md).
  //
  // draft holds the latest typed values and saved the last value loaded or saved for each field,
  // both as refs so that blur and unmount handlers see current values. A field is dirty when its
  // draft differs from saved.
  const draft = useRef({})
  const saved = useRef({})
  const latest = useRef({})
  draft.current = { title, note, current, target }
  latest.current = { goal, onUpdate, offline }
  const follow = (field, value, set) => {
    const clean = !(field in saved.current) || String(draft.current[field]) === String(saved.current[field])
    saved.current[field] = value
    if (clean) set(value)
  }
  useEffect(() => { follow('title', goal.title, setTitle) }, [goal.title])
  useEffect(() => { follow('note', goal.statusNote || '', setNote) }, [goal.statusNote])
  useEffect(() => { follow('current', goal.currentValue ?? '', setCurrent) }, [goal.currentValue])
  useEffect(() => { follow('target', goal.targetValue ?? '', setTarget) }, [goal.targetValue])

  // Saves the named fields exactly as their buttons do, once: a value equal to the saved one is not
  // sent again, and a value the button would refuse saves nothing and goes back to the saved one.
  const saveFields = (fields) => {
    const { goal: g, onUpdate: update, offline: off } = latest.current
    if (off) return
    const patch = {}
    // The saved values the patch replaces: a save that fails puts them back, so the field reads as
    // unsaved again and the next leave or button tries once more.
    const before = {}
    for (const field of fields) {
      const value = draft.current[field]
      before[field] = saved.current[field]
      // The number fields hold a number from the server and a string once typed in.
      if (String(value) === String(saved.current[field])) continue
      if (field === 'title') {
        if (!value.trim()) { setTitle(saved.current.title); continue }
        if (value.trim() === saved.current.title) continue
        patch.title = value.trim()
        saved.current.title = value.trim()
        setTitle(value.trim())
      } else if (field === 'note') {
        patch.statusNote = value
        saved.current.note = value
      } else {
        const key = field === 'current' ? 'currentValue' : 'targetValue'
        if (value !== '' && !Number.isFinite(Number(value))) {
          if (field === 'current') setCurrent(saved.current.current); else setTarget(saved.current.target)
          continue
        }
        patch[key] = value === '' ? null : Number(value)
        saved.current[field] = value
      }
    }
    if (Object.keys(patch).length === 0) return
    // Only the fields this save marked saved, and only while no poll has loaded a newer value.
    const after = {}
    for (const field of fields) if (saved.current[field] !== before[field]) after[field] = saved.current[field]
    Promise.resolve(update(g, patch)).then((ok) => {
      if (ok !== false) return
      for (const field of Object.keys(after)) if (saved.current[field] === after[field]) saved.current[field] = before[field]
    })
  }

  // A blur that moves focus inside the same control group (a field to its own Save button) is not
  // leaving, and the button saves anyway.
  const leave = (fields) => (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    saveFields(fields)
  }
  // Esc puts the field back to its saved value.
  const revertOnEsc = (field, set) => (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    set(saved.current[field])
  }

  // Collapsing the card or opening another goal unmounts this, which saves what is still unsaved.
  useEffect(() => () => saveFields(['title', 'note', 'current', 'target']), [])

  const load = useCallback(async () => {
    try {
      setDetail(await api.getGoal(goal.id))
      setError(null)
    } catch (err) {
      setError(err.message || 'Could not load this goal.')
    }
  }, [api, goal.id])

  useEffect(() => { load() }, [load, goal.updatedAt, goal.progress?.openTasks, goal.progress?.total])

  const change = async (fn) => {
    try {
      setDetail(await fn())
      setError(null)
      onChanged()
    } catch (err) {
      setError(err.message || 'That change did not save.')
    }
  }

  const linkedProjectIds = new Set((detail?.linkedProjects || []).map((p) => p.id))
  const linkable = projects.filter((p) => !linkedProjectIds.has(p.id))
  const manual = goal.progressMode === 'manual'

  return (
    <div className="goal-details">
      {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 14 }}>{error}</div>}

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`goal-title-${goal.id}`}>Goal title</label>
        <div className="goal-inline" onBlur={leave(['title'])}>
          <input id={`goal-title-${goal.id}`} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={revertOnEsc('title', setTitle)} style={{ minHeight: 44, padding: '0 12px' }} />
          <button type="button" className="btn" disabled={!title.trim() || title.trim() === goal.title || offline} onClick={() => saveFields(['title'])}>Rename</button>
        </div>
      </div>

      <div className="field" style={{ marginBottom: 0 }} onBlur={leave(['note'])}>
        <label htmlFor={`goal-note-${goal.id}`}>Status note</label>
        <textarea id={`goal-note-${goal.id}`} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={revertOnEsc('note', setNote)} rows={2} placeholder="One line on why it is on track, at risk, or off track" style={{ padding: '10px 12px' }} />
        <div>
          <button type="button" className="btn" disabled={note === (goal.statusNote || '') || offline} onClick={() => saveFields(['note'])}>Save note</button>
        </div>
      </div>

      {manual && (
        <div onBlur={leave(['current', 'target'])}>
          <div className="goal-manual-fields">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor={`goal-current-${goal.id}`}>Current{goal.unit ? ` (${goal.unit})` : ''}</label>
              <input id={`goal-current-${goal.id}`} type="number" inputMode="decimal" value={current} onChange={(e) => setCurrent(e.target.value)} onKeyDown={revertOnEsc('current', setCurrent)} style={{ minHeight: 44, padding: '0 12px' }} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor={`goal-target-${goal.id}`}>Target</label>
              <input id={`goal-target-${goal.id}`} type="number" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={revertOnEsc('target', setTarget)} style={{ minHeight: 44, padding: '0 12px' }} />
            </div>
          </div>
          <button
            type="button"
            className="btn"
            style={{ marginTop: 8 }}
            disabled={offline}
            onClick={() => saveFields(['current', 'target'])}
          >
            Save progress
          </button>
        </div>
      )}

      <section aria-label={`Projects linked to ${goal.title}`}>
        <h3 className="goal-subhead">Linked projects</h3>
        {(detail?.linkedProjects || []).length === 0 && <p className="goal-muted">None yet.</p>}
        {(detail?.linkedProjects || []).map((p) => (
          <div key={p.id} className="goal-linked-row">
            <span>{p.name}</span>
            <button type="button" className="icon-btn" aria-label={`Unlink project ${p.name}`} disabled={offline} onClick={() => change(() => api.unlinkGoal(goal.id, { project: p.id }))}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        ))}
        {linkable.length > 0 && (
          <div className="field" style={{ margin: '8px 0 0' }}>
            <label htmlFor={`goal-project-${goal.id}`}>Link a project</label>
            <select
              id={`goal-project-${goal.id}`}
              value=""
              onChange={(e) => { if (e.target.value) change(() => api.linkGoal(goal.id, { project: e.target.value })) }}
              disabled={offline}
              style={{ minHeight: 44, padding: '0 12px' }}
            >
              <option value="">Choose a project</option>
              {linkable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
      </section>

      <section aria-label={`Tasks linked to ${goal.title}`}>
        <h3 className="goal-subhead">Linked tasks</h3>
        {(detail?.linkedTasks || []).length === 0 && <p className="goal-muted">None yet.</p>}
        {(detail?.linkedTasks || []).map((t) => (
          <div key={t.id} className="goal-linked-row">
            <span style={{ textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{plainTitle(t.title)}</span>
            <button type="button" className="icon-btn" aria-label={`Unlink task ${t.title}`} disabled={offline} onClick={() => change(() => api.unlinkGoal(goal.id, { taskId: t.id }))}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <TaskSearch goal={goal} api={api} onLinked={(target) => change(() => api.linkGoal(goal.id, target))} />
        </div>
      </section>

      <section aria-label={`Open tasks that move ${goal.title}`}>
        <h3 className="goal-subhead">Open tasks that move this goal</h3>
        {(detail?.openTasks || []).length === 0
          ? <p className="goal-muted">None. Nothing open is moving this goal.</p>
          : (
            <ul className="goal-open-tasks">
              {detail.openTasks.slice(0, 12).map((t) => <li key={t.id}>{plainTitle(t.title)}{t.dueAt ? ` · due ${formatDueShort(t.dueAt)}` : ''}</li>)}
              {detail.openTasks.length > 12 && <li>and {detail.openTasks.length - 12} more</li>}
            </ul>
          )}
      </section>

      <div className="goal-choice-row">
        <button type="button" className="btn" disabled={offline} onClick={() => onAddSub(goal)}><Plus size={16} aria-hidden="true" /> Add sub-goal</button>
        <ConfirmButton label="Delete goal" confirmLabel="Delete goal" onConfirm={() => onDelete(goal)} disabled={offline} className="btn btn-danger" />
      </div>
    </div>
  )
}

function GoalCard({ goal, depth, expanded, onToggle, today, ...detailProps }) {
  const flags = goalFlags(goal, today)
  return (
    <article className="surface goal-card" aria-label={goal.title} style={{ marginLeft: `calc(${Math.min(depth, 3)} * var(--goal-indent))` }}>
      <div className="goal-header">
        <button
          type="button"
          className="icon-btn"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} details for ${goal.title}`}
          onClick={() => onToggle(goal.id)}
        >
          {expanded ? <ChevronDown size={20} aria-hidden="true" /> : <ChevronRight size={20} aria-hidden="true" />}
        </button>
        <div className="goal-title-block">
          <h2 className="goal-title">{goal.title}</h2>
          {goal.periodLabel && <span className="goal-period">{goal.periodLabel}</span>}
        </div>
        <StatusButton goal={goal} onChange={detailProps.onUpdate} />
      </div>

      <ProgressBar goal={goal} />

      {(flags.length > 0 || goal.statusNote) && (
        <div className="goal-flags">
          {flags.map((f) => <span key={f.key} className="badge goal-flag">{f.label}</span>)}
          {goal.statusNote && <span className="goal-note">{goal.statusNote}</span>}
        </div>
      )}

      {expanded && <GoalDetails goal={goal} {...detailProps} />}
    </article>
  )
}

function VisionCard({ vision, onSave }) {
  const offline = useOffline()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(vision)
  const [saveError, setSaveError] = useState(null)
  useEffect(() => { if (!editing) setDraft(vision) }, [vision, editing])

  if (!editing) {
    return (
      <section className="surface goal-vision" aria-label="Vision">
        <div>
          <h2 className="goal-subhead" style={{ marginTop: 0 }}>Vision</h2>
          <p className={vision ? 'goal-vision-text' : 'goal-muted'}>{vision || 'Where is all of this heading? One or two sentences.'}</p>
        </div>
        <button type="button" className="btn" disabled={offline} onClick={() => setEditing(true)}>{vision ? 'Edit vision' : 'Write vision'}</button>
      </section>
    )
  }
  return (
    <section className="surface goal-vision" aria-label="Vision" onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}>
      <div className="field" style={{ marginBottom: 0, flex: 1 }}>
        <label htmlFor="goal-vision-text">Vision</label>
        <textarea id="goal-vision-text" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus maxLength={4000} style={{ padding: '10px 12px' }} />
      </div>
      {saveError && <ErrorBanner message={saveError} />}
      <div className="goal-choice-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={offline}
          onClick={async () => {
            // Without the catch a rejected save left the editor open with no message, no state
            // change and an unhandled rejection: the button simply appeared to do nothing.
            try {
              await onSave(draft.trim())
              setSaveError(null)
              setEditing(false)
            } catch (err) {
              setSaveError(err.message || 'Could not save the vision.')
            }
          }}
        >Save vision</button>
        <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </section>
  )
}

export default function GoalsTab() {
  const { connected, api } = useConnection()
  const offline = useOffline()
  const [goals, setGoals] = useState([])
  const [vision, setVision] = useState('')
  const [total, setTotal] = useState(null)
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showClosed, setShowClosed] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [adding, setAdding] = useState(null) // null, 'top', or the parent goal
  const [legacy, setLegacy] = useState(null)
  const [importing, setImporting] = useState(false)
  const today = todayIso()

  const beginRequest = useRequestGuard()
  const fetchGoals = useCallback(async () => {
    const isCurrent = beginRequest()
    try {
      const res = await api.listGoals(showClosed)
      if (!isCurrent()) return
      setGoals(res.goals || [])
      setVision(res.vision || '')
      setTotal(typeof res.total === 'number' ? res.total : (res.goals || []).length)
      setError(null)
    } catch (err) {
      if (isCurrent()) setError(err.message || 'Could not load goals.')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [api, showClosed, beginRequest])

  useEffect(() => {
    if (!connected) return
    setLoading(true)
    fetchGoals()
  }, [connected, fetchGoals])

  useEffect(() => {
    if (!connected) return
    api.listProjects().then((res) => setProjects(res.projects || [])).catch(() => setProjects([]))
  }, [connected, api])

  // Offer the one-time import only when this browser still holds goals from the old tab.
  useEffect(() => {
    const storage = getStorage()
    if (storage && !importAlreadyDone(storage)) setLegacy(readLegacyGoals(storage))
  }, [])

  useEventRefresh(fetchGoals, { enabled: connected })

  const handleUpdate = useCallback(async (goal, patch) => {
    try {
      await api.updateGoal(goal.id, patch)
      await fetchGoals()
      return true
    } catch (err) {
      setError(err.message || 'That change did not save.')
      return false
    }
  }, [api, fetchGoals])

  const handleCreate = useCallback(async (payload) => {
    const res = await api.createGoal(payload)
    setAdding(null)
    await fetchGoals()
    if (res?.goal?.id) setExpandedId(res.goal.id)
  }, [api, fetchGoals])

  const handleDelete = useCallback(async (goal) => {
    try {
      await api.deleteGoal(goal.id)
      setExpandedId(null)
      await fetchGoals()
    } catch (err) {
      setError(err.message || 'Could not delete that goal.')
    }
  }, [api, fetchGoals])

  const dismissImport = () => {
    const storage = getStorage()
    if (storage) markImportDone(storage)
    setLegacy(null)
  }

  const runImport = async () => {
    if (!legacy || importing) return
    setImporting(true)
    try {
      if (legacy.vision && !vision) await api.setGoalVision(legacy.vision)
      for (const draft of legacy.goals) await api.createGoal(draft)
      dismissImport()
      await fetchGoals()
    } catch (err) {
      setError(err.message || 'The import stopped part way. Nothing was lost; try again.')
    } finally {
      setImporting(false)
    }
  }

  if (!connected) return <NotConnected />

  const rows = flattenGoalTree(goals)
  const attention = goals.filter((g) => goalFlags(g, today).length > 0).length

  return (
    <div className="goals-page">
      <VisionCard vision={vision} onSave={async (text) => { await api.setGoalVision(text); setVision(text) }} />

      {/* Only when the server has no goals at all: the old tab saved its built-in defaults in every
          browser, so offering this on a second device would duplicate goals that already exist. */}
      {legacy && !loading && total === 0 && (
        <section className="surface goal-import" aria-label="Import goals from this browser">
          <p>
            This browser still has {legacy.goals.length} {legacy.goals.length === 1 ? 'goal' : 'goals'} from the old Goals tab
            {legacy.vision ? ', plus a vision statement' : ''}. Import them so they show on every device?
          </p>
          <div className="goal-choice-row">
            <button type="button" className="btn btn-primary" disabled={importing || offline} onClick={runImport}>
              {importing ? 'Importing' : `Import ${legacy.goals.length} ${legacy.goals.length === 1 ? 'goal' : 'goals'}`}
            </button>
            <button type="button" className="btn" disabled={importing} onClick={dismissImport}>Not now</button>
          </div>
        </section>
      )}

      <div className="goals-toolbar" role="toolbar" aria-label="Goals">
        <button type="button" className="btn btn-primary" disabled={offline} onClick={() => setAdding('top')}><Plus size={18} aria-hidden="true" /> Add goal</button>
        <button type="button" className="btn" aria-pressed={showClosed} onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? 'Hide achieved and dropped' : 'Show achieved and dropped'}
        </button>
        {goals.length > 0 && (
          <span className="goals-summary" role="status">
            {goals.length} {goals.length === 1 ? 'goal' : 'goals'}, {attention} need attention
          </span>
        )}
      </div>

      {adding === 'top' && <AddGoalForm parent={null} onCreate={handleCreate} onCancel={() => setAdding(null)} />}

      <ErrorBanner message={error} onRetry={fetchGoals} />

      {loading ? (
        <Loading label="Loading goals…" />
      ) : goals.length === 0 ? (
        <EmptyState icon={Target} title="No goals yet" hint="Add one, then link the projects and tasks that move it." />
      ) : (
        rows.map(({ goal, depth }) => (
          <div key={goal.id}>
            <GoalCard
              goal={goal}
              depth={depth}
              today={today}
              expanded={expandedId === goal.id}
              onToggle={(id) => setExpandedId((cur) => (cur === id ? null : id))}
              api={api}
              projects={projects}
              onUpdate={handleUpdate}
              onChanged={fetchGoals}
              onAddSub={(parent) => setAdding(parent)}
              onDelete={handleDelete}
            />
            {adding && adding !== 'top' && adding.id === goal.id && (
              <div style={{ marginLeft: `calc(${Math.min(depth + 1, 3)} * var(--goal-indent))` }}>
                <AddGoalForm parent={goal} onCreate={handleCreate} onCancel={() => setAdding(null)} />
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
