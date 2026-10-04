import { useState, useEffect, useCallback, useRef, useId } from 'react'
import { X, Check, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { Loading, ErrorBanner, StatusChip, formatDate, PRIORITY_COLORS, STATUS_LABELS } from './shared'
import { SOURCE_LABELS } from './TaskRow'
import HandoffMenu from './HandoffMenu'
import { isSafeHref } from './SafeMarkdown'
import { useOffline } from './offlineStatus'
import { Menu } from './Menu'
import { useDefaultAgentName, rememberDefaultAgentName } from './defaultAgentName'

// History entries are CcEvent rows: { id, at, kind, taskId, actor, actorName, payload },
// plus `restore` from the server: what Put back would set, or null.
// task.updated events carry payload.changes, an object keyed by the fields
// that changed; show which fields for that kind, since the values themselves
// are internal shapes not meant for display. A sync conflict names its field
// and both values, so two conflicts from one replay can be told apart.
// actorName is the self-declared name an agent carried on its connection
// (docs/assign-to-ai-options.md, stage 5B): "agent" becomes "agent scribe".
// It is a display label, not an authenticated identity.
function historyLine(entry) {
  const actor = entry.actorName ? `${entry.actor} ${entry.actorName}` : entry.actor
  if (entry.kind === 'task.sync_conflict' && entry.payload?.field) {
    const { field, kept, discarded } = entry.payload
    return `${actor} ${entry.kind} (${fieldLabel(field)}: kept ${shortValue(kept)}, discarded ${shortValue(discarded)})`
  }
  const changedFields = entry.kind === 'task.updated' && entry.payload?.changes
    ? Object.keys(entry.payload.changes)
    : []
  const suffix = changedFields.length > 0 ? ` (${changedFields.join(', ')})` : ''
  return `${actor} ${entry.kind}${suffix}`
}

const FIELD_LABELS = {
  title: 'title', notes: 'notes', priority: 'priority', dueAt: 'due date', startAt: 'start date',
  estimateMinutes: 'estimate', recurrence: 'recurrence', assignee: 'assignee',
}

function fieldLabel(field) {
  return FIELD_LABELS[field] || field
}

function shortValue(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  const text = String(value).replace(/\s+/g, ' ').trim()
  return `"${text.length > 40 ? `${text.slice(0, 40)}...` : text}"`
}

// What Put back will do, from the entry's `restore` patch:
// `title to "Draft", notes to empty`.
function restoreSummary(patch) {
  return Object.entries(patch).map(([field, value]) => `${fieldLabel(field)} to ${shortValue(value)}`).join(', ')
}

// One label+value row of the fields grid: a 120px label column and a value
// column styled to sit flush with the label (a negative margin cancels its
// own padding) so editable controls -- due date, priority -- read the same
// as plain read-only text -- project, section, source.
// `htmlFor` turns the label into a real <label> for the control with that id,
// so the control's accessible name comes from the visible text.
function FieldRow({ label, htmlFor, children }) {
  const labelStyle = { fontSize: 13, color: 'var(--t2)' }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', alignItems: 'center', minHeight: 44 }}>
      {htmlFor ? <label htmlFor={htmlFor} style={labelStyle}>{label}</label> : <div style={labelStyle}>{label}</div>}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          minWidth: 0,
          padding: '0 10px',
          marginLeft: -10,
          borderRadius: 8,
          fontSize: 14,
          color: 'var(--t1)',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// The Goals row: the goals this task is linked to, each with a remove button, and a menu that
// links it to another open goal. A goal reached only through the task's project is not listed,
// since that link belongs to the project and is changed on the Goals view. Goal links are never
// queued offline (outbox.js has no op for them), so both controls are off without a server.
function GoalsField({ taskId, goals, disabled, onChanged, onError }) {
  const { api } = useConnection()
  const [menuOpen, setMenuOpen] = useState(false)
  const [openGoals, setOpenGoals] = useState(null)
  const [busy, setBusy] = useState(false)
  const addRef = useRef(null)

  async function openMenu() {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    setOpenGoals(null)
    setMenuOpen(true)
    try {
      const res = await api.listGoals()
      setOpenGoals(res.goals || [])
    } catch (err) {
      setMenuOpen(false)
      onError(err.message || 'Could not load goals.')
    }
  }

  async function change(write) {
    setBusy(true)
    onError(null)
    try {
      await write()
      await onChanged()
    } catch (err) {
      onError(err.message || 'Could not change the goal.')
    } finally {
      setBusy(false)
    }
  }

  const linkedIds = new Set(goals.map((g) => g.id))
  const choices = (openGoals || []).filter((g) => !linkedIds.has(g.id))
  const items = openGoals === null
    ? [{ key: 'loading', type: 'header', label: 'Loading goals' }]
    : choices.length === 0
      ? [{ key: 'none', type: 'header', label: openGoals.length === 0 ? 'No open goals' : 'Linked to every open goal' }]
      : choices.map((g) => ({
        key: g.id,
        label: g.title,
        onSelect: () => change(() => api.linkGoal(g.id, { taskId })),
      }))

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {goals.map((g) => (
        <span
          key={g.id}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minWidth: 0,
            maxWidth: '100%',
            paddingLeft: 10,
            borderRadius: 8,
            background: 'var(--bg-hover)',
          }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
          <button
            type="button"
            className="hover-surface"
            aria-label={`Remove from goal ${g.title}`}
            disabled={disabled || busy}
            onClick={() => change(() => api.unlinkGoal(g.id, { taskId }))}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              flexShrink: 0,
              background: 'transparent',
              border: 'none',
              borderRadius: 8,
              color: 'var(--t2)',
              cursor: disabled || busy ? 'default' : 'pointer',
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </span>
      ))}
      <button
        type="button"
        className="hover-surface"
        ref={addRef}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={disabled || busy}
        onClick={openMenu}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 44,
          padding: '0 10px',
          background: 'transparent',
          border: 'none',
          borderRadius: 8,
          font: 'inherit',
          fontSize: 14,
          color: 'var(--t2)',
          cursor: disabled || busy ? 'default' : 'pointer',
        }}
      >
        <Plus size={16} aria-hidden="true" /> Add to goal
      </button>
      <Menu anchorRef={addRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} label="Add to goal" minWidth={240} />
    </div>
  )
}

// Shared look for a form control that should blend into a FieldRow's value
// cell instead of looking like a boxed input.
const blendInputStyle = {
  background: 'transparent',
  border: 'none',
  boxShadow: 'none',
  color: 'inherit',
  font: 'inherit',
  fontSize: 14,
  padding: 0,
  width: '100%',
}

// A 44x44 icon-only button with the app's standard hover treatment.
function IconButton({ children, onClick, ariaLabel }) {
  return (
    <button type="button" className="icon-btn" onClick={onClick} aria-label={ariaLabel} style={{ color: 'var(--t1)' }}>
      {children}
    </button>
  )
}

const sectionHeading = { fontSize: 14, fontWeight: 600, color: 'var(--t1)' }

// The outlined 44px control shared by the header buttons here (Mark complete, Assign to, Take
// back). Hand off to Claude Code is deliberately a different, raised style (HandoffMenu.jsx).
const headerBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 44,
  padding: '0 16px',
  border: '1px solid var(--bd-strong)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--t1)',
  fontSize: 14,
  whiteSpace: 'nowrap',
}

// Elements the Tab-trap cycles between (mirrors NavDrawer's focus trap).
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]'

// Task detail as a fixed right-hand panel (no dimming backdrop -- the My
// Tasks list stays visible and interactive to its left). Props are kept
// stable because BoardTab also renders this component.
export default function TaskDetailPanel({ taskId, onClose, onChanged, onOpenTask }) {
  const { api, local } = useConnection()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [form, setForm] = useState(null)
  const [projectInfo, setProjectInfo] = useState(null)
  const [subtaskPending, setSubtaskPending] = useState(() => new Set())
  const [moreOpen, setMoreOpen] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [actionNotice, setActionNotice] = useState(null)
  const [restoring, setRestoring] = useState(null)
  const agentName = useDefaultAgentName(api)
  const [assignBusy, setAssignBusy] = useState(false)
  // What the hidden live region reads out after an assign or a take back.
  const [assignNotice, setAssignNotice] = useState('')
  // The two buttons swap places once the reload lands, so focus is moved by an effect then.
  const assignBtnRef = useRef(null)
  const takeBackBtnRef = useRef(null)
  const pendingFocusRef = useRef(null)
  const offline = useOffline()
  const assigneeInputId = useId()

  // The form values as last loaded from the server, used to tell which fields
  // the user has edited but not saved yet.
  const serverFormRef = useRef(null)

  // Focus-trap plumbing (same approach as NavDrawer): the panel element,
  // whatever had focus before it opened (mount == open here, since the
  // parent only renders this component while a task is selected), and a
  // one-shot guard so the initial focus move happens only once.
  const panelRef = useRef(null)
  const openerRef = useRef(document.activeElement)
  const focusedOnOpenRef = useRef(false)

  // A quiet load is a background refresh: no loading state, no error banner,
  // and any field the user has changed since the last load keeps its draft.
  // Every reload after a write is quiet, so a slow save never throws away
  // text typed elsewhere meanwhile. `sent` holds the form values a save just
  // sent: those fields count as changed only if they moved on since, so the
  // server's version (a trimmed title, say) replaces what was sent.
  const load = useCallback(async ({ quiet = false, sent = {} } = {}) => {
    if (!quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      const res = await api.getTask(taskId)
      const fresh = {
        title: res.task.title || '',
        notes: res.task.notes || '',
        status: res.task.status || 'open',
        priority: res.task.priority || 'none',
        dueAt: res.task.dueAt ? res.task.dueAt.slice(0, 10) : '',
        recurrence: res.task.recurrence || '',
        assignee: res.task.assignee || '',
      }
      const previous = serverFormRef.current
      serverFormRef.current = fresh
      setData(res)
      setForm((current) => {
        if (!quiet || !current || !previous) return fresh
        const merged = { ...fresh }
        for (const key of Object.keys(fresh)) {
          const baseline = key in sent ? sent[key] : previous[key]
          if (current[key] !== baseline) merged[key] = current[key]
        }
        return merged
      })
    } catch (err) {
      if (!quiet) setError(err.message || 'Could not load this task.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [api, taskId])

  useEffect(() => { load() }, [load])

  // Pick up changes made elsewhere (another tab, the CLI, or an MCP client)
  // while the panel is open.
  useEventRefresh(() => load({ quiet: true }))

  // Resolve the project's and section's display names: the task API only
  // carries their ids, and getProject(id) is the endpoint that returns both.
  useEffect(() => {
    const projectId = data?.task?.projectId
    if (!projectId) {
      setProjectInfo(null)
      return undefined
    }
    let cancelled = false
    api.getProject(projectId).then((res) => {
      if (!cancelled) setProjectInfo(res)
    }).catch(() => {
      if (!cancelled) setProjectInfo(null)
    })
    return () => { cancelled = true }
  }, [api, data?.task?.projectId])

  // Moves focus to the button that replaced the one just used. It waits for the reload (the
  // buttons swap on `assignee`) and for the request to end (a busy button is disabled, and a
  // disabled button cannot take focus).
  const assignee = data?.task?.assignee || null
  useEffect(() => {
    if (assignBusy) return
    const target = pendingFocusRef.current
    if (target === 'take-back' && assignee) {
      pendingFocusRef.current = null
      takeBackBtnRef.current?.focus()
    } else if (target === 'assign' && !assignee) {
      pendingFocusRef.current = null
      assignBtnRef.current?.focus()
    }
  }, [assignee, assignBusy])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Tab/Shift+Tab focus trap while the panel is mounted (mirrors NavDrawer's).
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== 'Tab') return
      const focusables = panelRef.current
        ? Array.from(panelRef.current.querySelectorAll(FOCUSABLE_SELECTOR))
        : []
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !panelRef.current.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !panelRef.current.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Move focus into the panel once its first load settles (success or
  // error), and return focus to whatever opened it when it unmounts.
  useEffect(() => {
    if (!focusedOnOpenRef.current && !loading) {
      focusedOnOpenRef.current = true
      panelRef.current?.querySelector(FOCUSABLE_SELECTOR)?.focus()
    }
  }, [loading])

  useEffect(() => {
    const opener = openerRef.current
    return () => {
      opener?.focus?.()
    }
  }, [])

  // The "Prompt copied" notice from HandoffMenu is a short-lived status
  // line, not persistent state.
  useEffect(() => {
    if (!actionNotice) return undefined
    const t = setTimeout(() => setActionNotice(null), 5000)
    return () => clearTimeout(t)
  }, [actionNotice])

  // Fields (due date, priority, status, recurrence) save immediately on
  // change/blur -- there is no separate "Save" step in this layout. `sent`
  // is what the form held for those fields when it saved, where that differs
  // from the patch (a title before trimming, a date that may be empty).
  async function patchTask(patch, sent = patch) {
    setSaveError(null)
    try {
      await api.updateTask(taskId, patch)
      await load({ quiet: true, sent })
      onChanged?.()
    } catch (err) {
      setSaveError(err.message || 'Could not save changes.')
      return false
    }
    return true
  }

  async function handleCompleteToggle() {
    setSaveError(null)
    try {
      if (data.task.status === 'done') {
        await api.reopenTask(taskId)
      } else {
        await api.completeTask(taskId)
      }
      await load({ quiet: true })
      onChanged?.()
    } catch (err) {
      setSaveError(err.message || 'Could not update completion.')
    }
  }

  // 1A of docs/assign-to-ai-options.md: the click is a plain assignee claim, nothing more. The
  // agent itself picks the task up later, over MCP. Both buttons pass what the Assignee box
  // held as `sent`, so the reload replaces it unless it was edited during the request.
  async function handleAssignToAgent() {
    const shown = form.assignee
    setAssignBusy(true)
    setAssignNotice('')
    try {
      let name = agentName
      if (!name) {
        try {
          name = (await api.getAgentSettings())?.defaultAgentName
        } catch {
          name = null
        }
        if (!name) {
          setSaveError('Could not load the default agent name. Try again.')
          return
        }
        rememberDefaultAgentName(name)
      }
      pendingFocusRef.current = 'take-back'
      if (await patchTask({ assignee: name }, { assignee: shown })) setAssignNotice(`Assigned to ${name}`)
      else pendingFocusRef.current = null
    } finally {
      setAssignBusy(false)
    }
  }

  async function handleTakeBack() {
    const shown = form.assignee
    setAssignBusy(true)
    setAssignNotice('')
    try {
      pendingFocusRef.current = 'assign'
      if (await patchTask({ assignee: null }, { assignee: shown })) setAssignNotice('Assignment cleared')
      else pendingFocusRef.current = null
    } finally {
      setAssignBusy(false)
    }
  }

  async function handleToggleSubtask(sub) {
    setSubtaskPending((prev) => new Set(prev).add(sub.id))
    try {
      if (sub.status === 'done') {
        await api.reopenTask(sub.id)
      } else {
        await api.completeTask(sub.id)
      }
      await load({ quiet: true })
      onChanged?.()
    } catch (err) {
      setSaveError(err.message || 'Could not update that subtask.')
    } finally {
      setSubtaskPending((prev) => {
        const next = new Set(prev)
        next.delete(sub.id)
        return next
      })
    }
  }

  // Puts back what one history entry changed (core/restore.ts). The server
  // says what that would set, as `restore`.
  async function handleRestore(entry) {
    setSaveError(null)
    setRestoring(entry.id)
    try {
      await api.restoreTask(taskId, entry.id)
      await load({ quiet: true })
      onChanged?.()
    } catch (err) {
      setSaveError(err.message || 'Could not put that back.')
    } finally {
      setRestoring(null)
    }
  }

  async function handleAddComment() {
    const body = commentDraft.trim()
    if (!body || commentBusy) return
    setCommentBusy(true)
    try {
      await api.addComment(taskId, body)
      setCommentDraft('')
      await load({ quiet: true })
    } catch (err) {
      setSaveError(err.message || 'Could not add comment.')
    } finally {
      setCommentBusy(false)
    }
  }

  const done = data?.task?.status === 'done'
  const projectName = projectInfo?.project?.name || null
  const sectionName = data?.task?.sectionId
    ? (projectInfo?.sections || []).find((s) => s.id === data.task.sectionId)?.name
    : null
  const sourceLabel = data?.task ? (SOURCE_LABELS[data.task.sourceType] || 'Manual') : ''
  const subtasks = data?.subtasks || []
  const subtasksDone = subtasks.filter((s) => s.status === 'done').length

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Task details"
      style={{
        position: 'fixed',
        top: 56,
        right: 0,
        bottom: 0,
        width: 560,
        maxWidth: '100%',
        background: 'var(--bg3)',
        borderLeft: '1px solid var(--bd-surface)',
        boxShadow: 'var(--shadow-pop)',
        zIndex: 200,
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '16px 28px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div role="status" className="sr-only">{assignNotice}</div>
      {loading && <Loading label="Loading task…" />}
      <ErrorBanner message={error} onRetry={load} />

      {!loading && data && form && (
        <>
          {/* The actions wrap onto as many rows as they need; Close stays on the first row at the
              right, so it never drops below them (the phone rule in index.css pins it the same way). */}
          <div className="task-panel-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: '1 1 auto', minWidth: 0 }}>
              <button
                type="button"
                onClick={handleCompleteToggle}
                style={{ ...headerBtnStyle, color: done ? 'var(--green)' : 'var(--t1)', fontWeight: done ? 600 : 400 }}
              >
                <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                <span>{done ? 'Completed' : 'Mark complete'}</span>
              </button>
              <HandoffMenu task={data.task} project={projectInfo?.project || null} onNotice={setActionNotice} />
              {data.task.assignee ? (
                <>
                  <span
                    className="badge badge-software"
                    title={data.task.assignee}
                    style={{ maxWidth: '100%', display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    Assigned to {data.task.assignee}
                  </span>
                  <button
                    ref={takeBackBtnRef}
                    type="button"
                    className="hover-surface"
                    onClick={handleTakeBack}
                    disabled={offline || assignBusy}
                    style={headerBtnStyle}
                  >
                    {assignBusy ? 'Taking back…' : 'Take back'}
                  </button>
                </>
              ) : data.task.status === 'inbox' || data.task.untrustedText ? null : (
                // Propose, do not act: the owner accepts an inbox item first, and text written by a
                // third party (untrustedText) is never handed to an agent by one click. The Assignee
                // box below still works for the owner.
                <button
                  ref={assignBtnRef}
                  type="button"
                  className="hover-surface"
                  onClick={handleAssignToAgent}
                  disabled={offline || assignBusy}
                  style={headerBtnStyle}
                >
                  {assignBusy ? 'Assigning…' : `Assign to ${agentName ?? 'agent'}`}
                </button>
              )}
            </div>
            <span className="task-panel-close">
              <IconButton ariaLabel="Close task details" onClick={onClose}>
                <X size={20} aria-hidden="true" />
              </IconButton>
            </span>
          </div>

          {actionNotice && (
            <div style={{ fontSize: 13, color: 'var(--t2)' }}>
              {actionNotice.href ? (
                <a href={actionNotice.href} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)' }}>
                  {actionNotice.text}
                </a>
              ) : (
                actionNotice.text
              )}
            </div>
          )}

          <input
            value={form.title}
            onChange={(e) => { const { value } = e.target; setForm((f) => ({ ...f, title: value })) }}
            onBlur={() => {
              const trimmed = form.title.trim()
              if (trimmed && trimmed !== data.task.title) patchTask({ title: trimmed }, { title: form.title })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            aria-label="Task title"
            style={{
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
              color: 'var(--t1)',
              font: 'inherit',
              fontSize: 24,
              fontWeight: 600,
              lineHeight: 1.3,
              padding: 0,
              width: '100%',
            }}
          />

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <FieldRow label="Due date">
              <input
                type="date"
                value={form.dueAt}
                onChange={(e) => {
                  const { value } = e.target
                  setForm((f) => ({ ...f, dueAt: value }))
                  patchTask({ dueAt: value || null }, { dueAt: value })
                }}
                aria-label="Due date"
                style={blendInputStyle}
              />
            </FieldRow>
            <FieldRow label="Project">
              <span style={{ color: projectName ? 'var(--t1)' : 'var(--t2)' }}>{projectName || 'None'}</span>
            </FieldRow>
            <FieldRow label="Section">
              <span style={{ color: sectionName ? 'var(--t1)' : 'var(--t2)' }}>{sectionName || 'None'}</span>
            </FieldRow>
            <FieldRow label="Goals">
              <GoalsField
                taskId={taskId}
                goals={data.goals || []}
                disabled={offline || local}
                onChanged={async () => {
                  await load({ quiet: true })
                  onChanged?.()
                }}
                onError={setSaveError}
              />
            </FieldRow>
            <FieldRow label="Priority">
              <select
                value={form.priority}
                onChange={(e) => {
                  // Read now: React runs the updater later, and may have put the
                  // controlled select back to its old value by then.
                  const { value } = e.target
                  setForm((f) => ({ ...f, priority: value }))
                  patchTask({ priority: value })
                }}
                aria-label="Priority"
                style={{ ...blendInputStyle, color: PRIORITY_COLORS[form.priority] || 'var(--t1)', cursor: 'pointer' }}
              >
                <option value="none">None</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </FieldRow>
            <FieldRow label="Assignee" htmlFor={assigneeInputId}>
              <input
                id={assigneeInputId}
                value={form.assignee}
                onChange={(e) => { const { value } = e.target; setForm((f) => ({ ...f, assignee: value })) }}
                onBlur={() => {
                  const next = form.assignee.trim() || null
                  if (next !== (data.task.assignee || null)) patchTask({ assignee: next }, { assignee: form.assignee })
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                placeholder="Unassigned"
                autoComplete="off"
                style={blendInputStyle}
              />
              {(form.assignee || data.task.assignee) && (
                <button
                  type="button"
                  className="hover-surface"
                  aria-label="Clear assignee"
                  onClick={() => {
                    // Always sent: a click here may land right after the input's blur saved a
                    // draft, and the server must end up with the clear, not the draft.
                    setForm((f) => ({ ...f, assignee: '' }))
                    patchTask({ assignee: null }, { assignee: '' })
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 44,
                    height: 44,
                    flexShrink: 0,
                    marginRight: -10,
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 8,
                    color: 'var(--t2)',
                    cursor: 'pointer',
                  }}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              )}
            </FieldRow>
            <FieldRow label="Source">
              <span style={{ flexShrink: 0 }}>{sourceLabel}</span>
              {data.task.sourceUrl && (
                // sourceUrl comes from the source item, so on a third-party task it is
                // attacker-controlled. The Inbox already gates it on isSafeHref; without the same
                // gate here a javascript: url renders as plain text at triage and then becomes a
                // working script link in this panel, in the origin that holds the API token.
                isSafeHref(data.task.sourceUrl) ? (
                  <a
                    href={data.task.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--blue)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {data.task.sourceUrl}
                  </a>
                ) : (
                  <span style={{ color: 'var(--t2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {data.task.sourceUrl}
                  </span>
                )
              )}
            </FieldRow>
          </div>

          {saveError && <div style={{ color: 'var(--red)', fontSize: '0.82rem' }}>{saveError}</div>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={sectionHeading}>Notes</div>
            <textarea
              value={form.notes}
              onChange={(e) => { const { value } = e.target; setForm((f) => ({ ...f, notes: value })) }}
              onBlur={() => { if (form.notes !== data.task.notes) patchTask({ notes: form.notes }) }}
              placeholder="Add notes"
              aria-label="Notes"
              style={{
                minHeight: 72,
                padding: '12px 14px',
                border: '1px solid var(--bd-strong)',
                borderRadius: 8,
                background: 'var(--bg-inset)',
                fontSize: 14,
                color: 'var(--t1)',
                resize: 'vertical',
                width: '100%',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <div style={sectionHeading}>Subtasks</div>
              {subtasks.length > 0 && (
                <div style={{ fontSize: 13, color: 'var(--t2)' }}>{subtasksDone} of {subtasks.length} done</div>
              )}
            </div>
            {subtasks.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--t2)', padding: '8px 0' }}>No subtasks.</div>
            )}
            {subtasks.map((s) => {
              const subDone = s.status === 'done'
              const pending = subtaskPending.has(s.id)
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '44px minmax(0, 1fr)',
                    alignItems: 'center',
                    minHeight: 44,
                    borderBottom: '1px solid var(--bd)',
                  }}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={subDone}
                    aria-label={subDone ? `Reopen ${s.title}` : `Complete ${s.title}`}
                    disabled={pending}
                    onClick={() => handleToggleSubtask(s)}
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
                    <span
                      aria-hidden="true"
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        border: `2px solid ${subDone ? 'var(--green)' : 'var(--t2)'}`,
                        background: subDone ? 'var(--green)' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {subDone && <Check size={12} strokeWidth={3} style={{ color: 'var(--on-accent)' }} />}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenTask?.(s.id)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      textAlign: 'left',
                      padding: 0,
                      fontSize: 14,
                      color: subDone ? 'var(--t2)' : 'var(--t1)',
                      textDecoration: subDone ? 'line-through' : 'none',
                      cursor: 'pointer',
                      minHeight: 44,
                      display: 'flex',
                      alignItems: 'center',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.title}
                  </button>
                </div>
              )
            })}
          </div>

          <div>
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                minHeight: 44,
                padding: '0 10px',
                marginLeft: -10,
                background: 'transparent',
                border: 'none',
                borderRadius: 8,
                color: 'var(--t1)',
                fontSize: 14,
                fontWeight: 600,
                textAlign: 'left',
              }}
            >
              {moreOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
              <span>More details</span>
            </button>

            {moreOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 8 }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <FieldRow label="Status">
                    <select
                      value={form.status}
                      onChange={(e) => {
                        const { value } = e.target
                        setForm((f) => ({ ...f, status: value }))
                        patchTask({ status: value })
                      }}
                      aria-label="Status"
                      style={{ ...blendInputStyle, cursor: 'pointer' }}
                    >
                      {Object.entries(STATUS_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </FieldRow>
                  <FieldRow label="Recurrence">
                    <input
                      value={form.recurrence}
                      onChange={(e) => { const { value } = e.target; setForm((f) => ({ ...f, recurrence: value })) }}
                      onBlur={() => {
                        const next = form.recurrence || null
                        if (next !== (data.task.recurrence || null)) patchTask({ recurrence: next }, { recurrence: form.recurrence })
                      }}
                      aria-label="Recurrence"
                      placeholder="e.g. FREQ=WEEKLY;BYDAY=MO"
                      style={blendInputStyle}
                    />
                  </FieldRow>
                </div>

                {data.blockers?.length > 0 && (
                  <div>
                    <div style={{ ...sectionHeading, marginBottom: 4 }}>Blocked by</div>
                    {data.blockers.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => onOpenTask?.(b.id)}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                          width: '100%',
                          minHeight: 44,
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--t1)',
                          textAlign: 'left',
                          fontSize: 14,
                        }}
                      >
                        <span>{b.title}</span>
                        <StatusChip status={b.status} />
                      </button>
                    ))}
                  </div>
                )}

                {data.blocking?.length > 0 && (
                  <div>
                    <div style={{ ...sectionHeading, marginBottom: 4 }}>Blocking</div>
                    {data.blocking.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => onOpenTask?.(b.id)}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                          width: '100%',
                          minHeight: 44,
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--t1)',
                          textAlign: 'left',
                          fontSize: 14,
                        }}
                      >
                        <span>{b.title}</span>
                        <StatusChip status={b.status} />
                      </button>
                    ))}
                  </div>
                )}

                {data.history?.length > 0 && (
                  <div>
                    <div style={{ ...sectionHeading, marginBottom: 4 }}>History</div>
                    {data.history.map((h) => (
                      <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t2)', padding: '6px 0', borderBottom: '1px solid var(--bd)' }}>
                        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                          {h.at ? new Date(h.at).toLocaleString() : ''} · {historyLine(h)}
                          {h.restore && (
                            <span style={{ display: 'block', color: 'var(--t3)' }}>Put back sets {restoreSummary(h.restore)}</span>
                          )}
                        </span>
                        {h.restore && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => handleRestore(h)}
                            disabled={offline || restoring !== null}
                            aria-label={`Put back ${restoreSummary(h.restore)}`}
                          >
                            {restoring === h.id ? 'Putting back...' : 'Put back'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={sectionHeading}>Comments</div>
            {(data.comments || []).length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--t2)' }}>No comments yet.</div>
            )}
            {(data.comments || []).map((c) => (
              <div key={c.id} style={{ background: 'var(--bg-inset)', border: '1px solid var(--bd)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 4 }}>
                  {c.author || 'You'}{c.authorName ? ` ${c.authorName}` : ''} · {formatDate(c.createdAt)}
                </div>
                <div style={{ fontSize: 14, color: 'var(--t1)', whiteSpace: 'pre-wrap' }}>{c.body}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 'auto', display: 'flex', gap: 8 }}>
            <input
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddComment() } }}
              placeholder="Add a comment"
              aria-label="Add a comment"
              disabled={commentBusy}
              style={{
                flexGrow: 1,
                minWidth: 0,
                height: 44,
                padding: '0 14px',
                border: '1px solid var(--bd-strong)',
                borderRadius: 8,
                background: 'var(--bg-inset)',
                color: 'var(--t1)',
                fontSize: 14,
              }}
            />
            <button
              type="button"
              onClick={handleAddComment}
              disabled={commentBusy || !commentDraft.trim()}
              style={{
                flexShrink: 0,
                height: 44,
                padding: '0 16px',
                border: '1px solid var(--bd-strong)',
                borderRadius: 8,
                background: 'var(--bg3)',
                color: 'var(--t1)',
                fontSize: 14,
              }}
            >
              {commentBusy ? 'Adding…' : 'Comment'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
