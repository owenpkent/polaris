import { useState, useEffect, useCallback, useRef, useId } from 'react'
import { X, Check, Calendar, ChevronDown, ChevronRight, Plus, Repeat, Bot, UserX } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { Loading, ErrorBanner, StatusChip, ProjectChip, Avatar, formatDate, PRIORITY_COLORS, STATUS_LABELS } from './shared'
import { SOURCE_LABELS } from './TaskRow'
import DueDateMenu from './DueDateMenu'
import { oneLine, useFitToText } from './useFitToText'
import { formatDueCell, getDueBounds, repeatLabel } from './dueDates'
import HandoffMenu from './HandoffMenu'
import { isSafeHref } from './SafeMarkdown'
import { useOffline } from './offlineStatus'
import { Menu } from './Menu'
import RepeatBuilder, { useRecurrencePreview } from './RepeatBuilder'
import { parseRule, buildRule, defaultShape, quickPicks, matchQuickPick, countsFromCompletion } from './recurrenceRules'
import { useDefaultAgentName, rememberDefaultAgentName } from './defaultAgentName'
import ThreadSection from './ThreadSection'
import CompleteBurst, { useCelebration } from './CompleteBurst'

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
          flexWrap: 'wrap',
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
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{g.title}</span>
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

// The Due date row's value: a calendar circle and the date as the list writes it (Today,
// Tomorrow, a weekday, or a short date, then the time when there is one) on a button that opens
// the shared picker, plus a clear button once a date is set. `value` is the form's dueAt, a day or
// a day and a time ('' for none). The picker also sets the repeat (`recurrence`, '' for none):
// `onChange` gets the new dueAt and, when a plain repeat followed a new day, the new rule, and
// `onRecurrenceChange` gets a rule chosen there and, when the task had no date, today.
function DueDateField({ value, onChange, recurrence, onRecurrenceChange, api }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const due = value ? formatDueCell(value, getDueBounds()) : { text: '', color: null }
  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="due-field"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={value ? `Due date, ${due.text}` : 'Due date, none'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={value ? 'due-field-icon is-set' : 'due-field-icon'} aria-hidden="true">
          <Calendar size={14} />
        </span>
        <span style={{ color: value ? due.color || 'var(--t1)' : 'var(--t2)', fontWeight: value ? 500 : 400 }}>
          {value ? due.text : 'No due date'}
        </span>
      </button>
      <DueDateMenu
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        value={value || null}
        dueBounds={getDueBounds()}
        onChange={(next, rule) => onChange(next || '', rule === undefined ? undefined : rule || '')}
        recurrence={recurrence || null}
        onRecurrenceChange={(rule, due) => onRecurrenceChange(rule || '', due === undefined ? undefined : due || '')}
        api={api}
        label="Due date"
      />
      {value && (
        <button
          type="button"
          className="hover-surface"
          aria-label="Clear due date"
          onClick={() => onChange('')}
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
            cursor: 'pointer',
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </>
  )
}

// The repeat choices offered beside the due date: the quick picks worded from the due date (or
// today), as Google Calendar lists them (recurrenceRules.js), and Custom, which opens the builder
// (RepeatBuilder.jsx) in the panel under the due date, to tap out any other rule: every N units,
// counted from the due date or the finish, the weekdays of a weekly rule, the day of a monthly
// one, and when it ends. A rule the builder cannot show (a raw RRULE with BYMONTH, say) is edited
// in the Recurrence box under More details instead, which Custom then opens.
function RepeatField({ value, dueIso, onChange, onCustom, buttonRef, building }) {
  const [open, setOpen] = useState(false)
  const label = repeatLabel(value)
  const matched = matchQuickPick(value, dueIso)
  const items = [
    ...quickPicks(dueIso).map((pick) => ({
      key: pick.rule || 'never',
      label: pick.label,
      radio: true,
      checked: matched === pick.rule,
      onSelect: () => onChange(pick.rule),
    })),
    { type: 'separator', key: 'sep-custom' },
    {
      key: 'custom',
      label: 'Custom',
      radio: true,
      checked: matched === null,
      onSelect: onCustom,
    },
  ]
  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className="due-field"
        aria-haspopup="menu"
        aria-expanded={open || building}
        aria-label={label ? `Repeat, ${label}` : 'Repeat, never'}
        onClick={() => setOpen((v) => !v)}
        style={{ marginLeft: 0 }}
      >
        <Repeat size={14} aria-hidden="true" style={{ color: label ? 'var(--blue)' : 'var(--t3)', flexShrink: 0 }} />
        <span style={{ color: label ? 'var(--t1)' : 'var(--t2)' }}>{label ? `Repeats ${label}` : 'Repeat'}</span>
      </button>
      <Menu anchorRef={buttonRef} open={open} onClose={() => setOpen(false)} items={items} label="Repeat" minWidth={240} />
    </>
  )
}

// The custom repeat builder, opened from the Repeat menu's Custom as a section of the panel under
// the due date rather than a popover: it grows as its choices do (day to week adds the weekday
// buttons), and in the panel's own column it never has to be placed again or run off the screen.
// Save writes the rule, Cancel or Esc leaves it, and either puts focus back on the Repeat button.
function RepeatBuilderSection({ draft, dueIso, api, onDraft, onSave, onCancel }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.querySelector('button:not(:disabled), select')?.focus()
  }, [])
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Custom repeat"
      className="repeat-inline"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // The panel closes on Esc (a window listener); here it closes only the builder.
        e.stopPropagation()
        onCancel()
      }}
    >
      <RepeatBuilder value={draft} dueIso={dueIso} onChange={onDraft} api={api} />
      <div className="sheet-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!draft} onClick={onSave}>Save</button>
      </div>
    </div>
  )
}

function formatLongDate(iso) {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// Under the due date of an open repeating task: the date completing it will bring the next one
// to, and Skip this one, which moves the task to that date without completing it. Skip is
// live-only (api.js), so it is off while offline, and so is the date, which the server works out.
// A rule counted from the finish has no next date until the task is done, so the row says that and
// names the date a skip moves it to, since a skip counts from the due date.
function NextOccurrenceRow({ rule, dueAt, api, offline, onSkip, busy }) {
  const dates = useRecurrencePreview(api, rule, dueAt, 1)
  const fromCompletion = countsFromCompletion(rule)
  const text = !dates
    ? null
    : !dates.length
      ? 'This is the last one.'
      : fromCompletion
        ? `Counted from the day you finish it. Skipping moves it to ${formatLongDate(dates[0])}.`
        : formatLongDate(dates[0])
  return (
    <FieldRow label="Next">
      <span style={{ color: 'var(--t2)' }}>{text || (offline ? 'Shown when online.' : '')}</span>
      {dates?.length > 0 && (
        <button type="button" className="btn" disabled={offline || busy} onClick={onSkip}>
          Skip this one
        </button>
      )}
    </FieldRow>
  )
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
  // The title box is as tall as its text (the textarea under the action buttons), and so is the
  // assignee box. The hook returns the ref to put on each, and follows the box itself: a load
  // unmounts both and mounts new ones, which must be measured even when the text is the same.
  const titleRef = useFitToText(form?.title)
  const assigneeRef = useFitToText(form?.assignee)
  // Notes grow with their text too, so the box has no frame or scroll bar of its own at rest.
  const notesRef = useFitToText(form?.notes)
  const notesId = useId()
  // The header row draws its bottom line only once the panel has scrolled under it.
  const [scrolled, setScrolled] = useState(false)
  // Add subtask: the name box at the end of the list, open after the header's + or the
  // Add subtask row is used, and the name typed there.
  const [addingSubtask, setAddingSubtask] = useState(false)
  const [subtaskDraft, setSubtaskDraft] = useState('')
  const [subtaskBusy, setSubtaskBusy] = useState(false)
  const subtaskInputRef = useRef(null)
  const addSubtaskRowRef = useRef(null)
  useEffect(() => { setAddingSubtask(false); setSubtaskDraft('') }, [taskId])
  const [projectInfo, setProjectInfo] = useState(null)
  const [subtaskPending, setSubtaskPending] = useState(() => new Set())
  // The check that celebrates a completion: the task's own button, or the subtask last ticked.
  const taskCelebration = useCelebration()
  const subCelebration = useCelebration()
  const [celebratedSubId, setCelebratedSubId] = useState(null)
  const [moreOpen, setMoreOpen] = useState(false)
  // The Recurrence box under More details, which the Repeat menu's Custom opens for a rule the builder cannot show.
  const recurrenceRef = useRef(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [actionNotice, setActionNotice] = useState(null)
  const [skipBusy, setSkipBusy] = useState(false)
  const [restoring, setRestoring] = useState(null)
  // Save as checklist: busy while the request is out, then the line that says where it went.
  const [checklistBusy, setChecklistBusy] = useState(false)
  const [checklistNotice, setChecklistNotice] = useState('')
  useEffect(() => { setChecklistNotice('') }, [taskId])
  // The custom repeat builder's rule while it is open under the due date, else null.
  const [repeatDraft, setRepeatDraft] = useState(null)
  const repeatBtnRef = useRef(null)
  useEffect(() => { setRepeatDraft(null) }, [taskId])
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
  // Bumped on every task load, so the thread section reloads with the panel (its own writes and
  // the events poll) instead of polling for itself.
  const [loadSeq, setLoadSeq] = useState(0)

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
        // The whole due date, its time included: slicing it to the day here would drop the time
        // on the next save of any field that sends the form's dueAt.
        dueAt: res.task.dueAt || '',
        recurrence: res.task.recurrence || '',
        assignee: res.task.assignee || '',
      }
      const previous = serverFormRef.current
      serverFormRef.current = fresh
      setData(res)
      setLoadSeq((n) => n + 1)
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
      // A menu opened from the panel is portalled to <body> (Menu.jsx), so focus in it is still
      // the panel's. Left alone, Tab in the date box moves between its segments as the browser
      // does it, instead of being pulled back to the panel's first control.
      if (active?.closest('[data-popover]')) return
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
    const completing = data.task.status !== 'done'
    try {
      if (!completing) {
        await api.reopenTask(taskId)
      } else {
        const res = await api.completeTask(taskId)
        // Queued offline there is no answer yet, and so no next date to name.
        if (res?.next?.dueAt) setActionNotice({ text: `Done. The next one is due ${formatLongDate(res.next.dueAt.slice(0, 10))}.` })
      }
      await load({ quiet: true })
      // Only now, with the done state on screen: started on the click, a slow request would use up
      // the burst before it could show, and a failed one never gets here.
      if (completing) taskCelebration.celebrate()
      onChanged?.()
    } catch (err) {
      setSaveError(err.message || 'Could not update completion.')
    }
  }

  async function handleSkip() {
    setSaveError(null)
    setSkipBusy(true)
    try {
      const res = await api.skipOccurrence(taskId)
      if (res?.task?.dueAt) setActionNotice({ text: `Skipped. Now due ${formatLongDate(res.task.dueAt.slice(0, 10))}.` })
      await load({ quiet: true })
      onChanged?.()
    } catch (err) {
      setSaveError(err.message || 'Could not skip this one.')
    } finally {
      setSkipBusy(false)
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

  // A template from this task's subtasks, named after the task; it is renamed and edited on the
  // Checklists page. Live only: a checklist write has no offline op kind.
  async function handleSaveAsChecklist() {
    setChecklistBusy(true)
    setChecklistNotice('')
    try {
      const res = await api.saveTaskAsChecklist(taskId)
      setChecklistNotice(`Saved as the checklist "${res.checklist.name}". Find it under Checklists.`)
    } catch (err) {
      setSaveError(err.message || 'Could not save that as a checklist.')
    } finally {
      setChecklistBusy(false)
    }
  }

  async function handleToggleSubtask(sub) {
    const completing = sub.status !== 'done'
    setSubtaskPending((prev) => new Set(prev).add(sub.id))
    try {
      if (!completing) {
        await api.reopenTask(sub.id)
      } else {
        await api.completeTask(sub.id)
      }
      await load({ quiet: true })
      // After the reload, as for the task's own check, so the burst plays on a ticked box.
      if (completing) {
        setCelebratedSubId(sub.id)
        subCelebration.celebrate()
      }
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

  // A subtask is an ordinary task made under this one (the server gives it the parent's project).
  // The box stays open with focus in it, so a list is typed one name after another, as in Asana.
  // It works offline like the list's Add task: api.createTask is queued by the outbox as
  // create_task, and the queued subtask is added to this task's copy (outbox.js, addCreatedTask).
  async function handleAddSubtask() {
    const title = subtaskDraft.trim()
    if (!title || subtaskBusy) return
    setSaveError(null)
    setSubtaskBusy(true)
    try {
      await api.createTask({ title, parentId: taskId })
      setSubtaskDraft('')
      await load({ quiet: true })
      onChanged?.()
    } catch (err) {
      setSaveError(err.message || 'Could not add that subtask.')
    } finally {
      setSubtaskBusy(false)
    }
  }

  function openSubtaskBox() {
    setAddingSubtask(true)
    requestAnimationFrame(() => subtaskInputRef.current?.focus())
  }

  function closeSubtaskBox() {
    setAddingSubtask(false)
    setSubtaskDraft('')
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
  // Propose, do not act: an inbox item is the owner's to accept before work is planned under it.
  const canAddSubtask = Boolean(data?.task) && data.task.status !== 'inbox'

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Task details"
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
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
        // No top padding: the sticky header row brings its own, so it sits flush at the top.
        // A control reached with Tab scrolls clear of that row instead of under it.
        padding: '0 28px 24px',
        scrollPaddingTop: 72,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div role="status" className="sr-only">{assignNotice}</div>
      {(loading || error) && (
        // The panel has no top padding of its own (the header row brings it), so these do.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingTop: 16 }}>
          {loading && <Loading label="Loading task…" />}
          <ErrorBanner message={error} onRetry={load} />
        </div>
      )}

      {!loading && data && form && (
        <>
          {/* One row, as Asana's pane has it: Mark complete on the left, the quiet actions and Close
              on the right. Close is pinned to the row's top right (index.css), so when the actions
              cannot all fit (a phone at 320px, a long agent name) they wrap under it and it never
              moves. The row sticks to the top while the panel scrolls, so the way out and Mark
              complete stay in reach. */}
          <div className={scrolled ? 'task-panel-header is-scrolled' : 'task-panel-header'}>
            <button
              type="button"
              className={done ? 'panel-complete is-done' : 'panel-complete'}
              onClick={handleCompleteToggle}
            >
              <span className="panel-complete-pill">
                {/* Only while done: a failed completion stops the celebration at once. */}
                <span
                  key={taskCelebration.celebrating && done ? taskCelebration.key : 0}
                  className={taskCelebration.celebrating && done ? 'check-pop' : undefined}
                  style={{ display: 'flex' }}
                >
                  <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                </span>
                <span>{done ? 'Completed' : 'Mark complete'}</span>
              </span>
              {taskCelebration.celebrating && done && <CompleteBurst key={taskCelebration.key} />}
            </button>
            <div className="task-panel-actions">
              {data.task.assignee ? (
                // Who has it is in the Assignee field below, with its avatar; the button names them
                // too, for whoever reads the header alone. Its label hides on a phone (index.css).
                <button
                  ref={takeBackBtnRef}
                  type="button"
                  className="toolbar-btn panel-action"
                  onClick={handleTakeBack}
                  disabled={offline || assignBusy}
                  aria-label={assignBusy ? 'Taking back…' : 'Take back'}
                  title={`Assigned to ${data.task.assignee}. Take back.`}
                >
                  <UserX size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
                  <span className="panel-action-label">{assignBusy ? 'Taking back…' : 'Take back'}</span>
                </button>
              ) : data.task.status === 'inbox' || data.task.untrustedText ? null : (
                // Propose, do not act: the owner accepts an inbox item first, and text written by a
                // third party (untrustedText) is never handed to an agent by one click. The Assignee
                // box below still works for the owner.
                <button
                  ref={assignBtnRef}
                  type="button"
                  className="toolbar-btn panel-action"
                  onClick={handleAssignToAgent}
                  disabled={offline || assignBusy}
                  aria-label={assignBusy ? 'Assigning…' : `Assign to ${agentName ?? 'agent'}`}
                  title={`Assign to ${agentName ?? 'agent'}`}
                >
                  <Bot size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
                  <span className="panel-action-label">{assignBusy ? 'Assigning…' : `Assign to ${agentName ?? 'agent'}`}</span>
                </button>
              )}
              <HandoffMenu task={data.task} project={projectInfo?.project || null} onNotice={setActionNotice} />
            </div>
            <span className="task-panel-close">
              <IconButton ariaLabel="Close task details" onClick={onClose}>
                <X size={20} aria-hidden="true" />
              </IconButton>
            </span>
          </div>

          {actionNotice && (
            <div role="status" style={{ fontSize: 13, color: 'var(--t2)' }}>
              {actionNotice.href ? (
                <a href={actionNotice.href} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)' }}>
                  {actionNotice.text}
                </a>
              ) : (
                actionNotice.text
              )}
            </div>
          )}

          {/* A textarea that grows with its text, so a long title is read in full here rather
              than cut at the panel's edge (CONTRIBUTING.md, "Nothing is cut off"). It is still
              one line of meaning: Enter saves, and a pasted line break becomes a space. */}
          <textarea
            ref={titleRef}
            rows={1}
            value={form.title}
            onChange={(e) => { const value = oneLine(e.target.value); setForm((f) => ({ ...f, title: value })) }}
            onBlur={() => {
              const trimmed = form.title.trim()
              if (trimmed && trimmed !== data.task.title) patchTask({ title: trimmed }, { title: form.title })
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              e.currentTarget.blur()
            }}
            aria-label="Task title"
            style={{
              resize: 'none',
              overflow: 'hidden',
              display: 'block',
              // A flex column may shrink an overflow: hidden box to nothing; this one keeps its height.
              flexShrink: 0,
              overflowWrap: 'anywhere',
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
              color: 'var(--t1)',
              font: 'inherit',
              fontSize: 22,
              fontWeight: 600,
              lineHeight: 1.3,
              padding: 0,
              width: '100%',
            }}
          />

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <FieldRow label="Due date">
              <DueDateField
                value={form.dueAt}
                onChange={(value, rule) => {
                  if (rule === undefined) {
                    setForm((f) => ({ ...f, dueAt: value }))
                    patchTask({ dueAt: value || null }, { dueAt: value })
                    return
                  }
                  setForm((f) => ({ ...f, dueAt: value, recurrence: rule }))
                  patchTask({ dueAt: value || null, recurrence: rule || null }, { dueAt: value, recurrence: rule })
                }}
                recurrence={form.recurrence}
                onRecurrenceChange={(rule, due) => {
                  if (due === undefined) {
                    setForm((f) => ({ ...f, recurrence: rule }))
                    patchTask({ recurrence: rule || null }, { recurrence: rule })
                    return
                  }
                  setForm((f) => ({ ...f, recurrence: rule, dueAt: due }))
                  patchTask({ recurrence: rule || null, dueAt: due || null }, { recurrence: rule, dueAt: due })
                }}
                api={api}
              />
              <RepeatField
                value={form.recurrence}
                dueIso={form.dueAt ? form.dueAt.slice(0, 10) : null}
                buttonRef={repeatBtnRef}
                building={repeatDraft !== null}
                onChange={(value) => {
                  setForm((f) => ({ ...f, recurrence: value }))
                  patchTask({ recurrence: value || null }, { recurrence: value })
                }}
                onCustom={() => {
                  const dueIso = form.dueAt ? form.dueAt.slice(0, 10) : null
                  const shape = parseRule(form.recurrence, dueIso)
                  if (form.recurrence && !shape) {
                    setMoreOpen(true)
                    // The box is rendered by the More details section, so it exists after this render.
                    requestAnimationFrame(() => recurrenceRef.current?.focus())
                    return
                  }
                  // Spelled out, so the draft says what the builder shows: "weekly" on its own
                  // follows the due date, which can change while the builder is open.
                  setRepeatDraft(buildRule(shape || defaultShape(dueIso)))
                }}
              />
            </FieldRow>
            {repeatDraft !== null && (
              <RepeatBuilderSection
                draft={repeatDraft}
                dueIso={form.dueAt ? form.dueAt.slice(0, 10) : null}
                api={api}
                onDraft={setRepeatDraft}
                onCancel={() => { setRepeatDraft(null); repeatBtnRef.current?.focus() }}
                onSave={() => {
                  const value = repeatDraft
                  setRepeatDraft(null)
                  repeatBtnRef.current?.focus()
                  setForm((f) => ({ ...f, recurrence: value }))
                  patchTask({ recurrence: value || null }, { recurrence: value })
                }}
              />
            )}
            {data.task.recurrence && data.task.status !== 'done' && data.task.status !== 'dropped' && (
              <NextOccurrenceRow
                rule={data.task.recurrence}
                dueAt={data.task.dueAt ? data.task.dueAt.slice(0, 10) : null}
                api={api}
                offline={offline}
                busy={skipBusy}
                onSkip={handleSkip}
              />
            )}
            <FieldRow label="Project">
              {projectName ? (
                <ProjectChip name={projectName} wrap />
              ) : (
                <span style={{ color: 'var(--t2)' }}>None</span>
              )}
            </FieldRow>
            <FieldRow label="Section">
              {sectionName ? (
                <span className="badge badge-neutral">{sectionName}</span>
              ) : (
                <span style={{ color: 'var(--t2)' }}>None</span>
              )}
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
                className={form.priority && form.priority !== 'none' ? `priority-select is-${form.priority}` : 'priority-select'}
                style={{ ...blendInputStyle, background: undefined, width: undefined, color: PRIORITY_COLORS[form.priority] || 'var(--t1)' }}
              >
                <option value="none">None</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </FieldRow>
            <FieldRow label="Assignee" htmlFor={assigneeInputId}>
              {form.assignee.trim() ? <Avatar name={form.assignee} /> : null}
              {/* Grows with its text like the title, so a long name is read whole here. */}
              <textarea
                ref={assigneeRef}
                rows={1}
                id={assigneeInputId}
                value={form.assignee}
                onChange={(e) => { const value = oneLine(e.target.value); setForm((f) => ({ ...f, assignee: value })) }}
                onBlur={() => {
                  const next = form.assignee.trim() || null
                  if (next !== (data.task.assignee || null)) patchTask({ assignee: next }, { assignee: form.assignee })
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  e.currentTarget.blur()
                }}
                placeholder="Unassigned"
                autoComplete="off"
                style={{ ...blendInputStyle, width: undefined, flex: '1 1 0', minWidth: 0, display: 'block', resize: 'none', overflow: 'hidden', overflowWrap: 'anywhere' }}
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
                    style={{ color: 'var(--blue)', minWidth: 0, overflowWrap: 'anywhere' }}
                  >
                    {data.task.sourceUrl}
                  </a>
                ) : (
                  <span style={{ color: 'var(--t2)', minWidth: 0, overflowWrap: 'anywhere' }}>
                    {data.task.sourceUrl}
                  </span>
                )
              )}
            </FieldRow>
          </div>

          {saveError && <div style={{ color: 'var(--red)', fontSize: '0.82rem' }}>{saveError}</div>}

          {/* Asana's description: no box at rest, only the text or the placeholder, and the inset
              box with its focus ring while it is being written in (.panel-notes in index.css). */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label htmlFor={notesId} style={sectionHeading}>Notes</label>
            <textarea
              ref={notesRef}
              id={notesId}
              className="panel-notes"
              rows={1}
              value={form.notes}
              onChange={(e) => { const { value } = e.target; setForm((f) => ({ ...f, notes: value })) }}
              onBlur={() => { if (form.notes !== data.task.notes) patchTask({ notes: form.notes }) }}
              placeholder="What is this task about?"
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {/* Asana's header line: the name, a done / total chip, and a + that opens the name box
                at the end of the list. */}
            <div className="panel-section-head">
              <div style={sectionHeading}>Subtasks</div>
              {subtasks.length > 0 && (
                <span className="count-chip">
                  <span aria-hidden="true">{subtasksDone} / {subtasks.length}</span>
                  <span className="sr-only">{subtasksDone} of {subtasks.length} done</span>
                </span>
              )}
              {canAddSubtask && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Add subtask"
                  title="Add subtask"
                  onClick={openSubtaskBox}
                >
                  <Plus size={18} aria-hidden="true" />
                </button>
              )}
            </div>
            {subtasks.length === 0 && !canAddSubtask && (
              <div style={{ fontSize: 13, color: 'var(--t2)', padding: '8px 0' }}>No subtasks.</div>
            )}
            {subtasks.map((s) => {
              const subDone = s.status === 'done'
              const pending = subtaskPending.has(s.id)
              const subCelebrating = subCelebration.celebrating && celebratedSubId === s.id && subDone
              return (
                <div key={s.id} className="subtask-row">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={subDone}
                    aria-label={subDone ? `Reopen ${s.title}` : `Complete ${s.title}`}
                    disabled={pending}
                    onClick={() => handleToggleSubtask(s)}
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
                      opacity: pending && !subCelebrating ? 0.6 : 1,
                    }}
                  >
                    <span
                      key={subCelebrating ? subCelebration.key : 0}
                      aria-hidden="true"
                      className={subCelebrating ? 'check-pop' : undefined}
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
                    {subCelebrating && <CompleteBurst key={subCelebration.key} />}
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
                      // The panel is where a title is read in full, so a subtask wraps.
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {s.title}
                  </button>
                </div>
              )
            })}
            {canAddSubtask && (addingSubtask ? (
              <div className="subtask-row">
                <span className="subtask-add-circle" aria-hidden="true" />
                <input
                  ref={subtaskInputRef}
                  className="subtask-add-input"
                  value={subtaskDraft}
                  onChange={(e) => setSubtaskDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddSubtask()
                    } else if (e.key === 'Escape') {
                      // The panel closes on Esc (a window listener); here it closes only the box.
                      e.stopPropagation()
                      closeSubtaskBox()
                      requestAnimationFrame(() => addSubtaskRowRef.current?.focus())
                    }
                  }}
                  onBlur={() => { if (!subtaskDraft.trim() && !subtaskBusy) closeSubtaskBox() }}
                  aria-label="Subtask name"
                  aria-busy={subtaskBusy}
                  placeholder="Write a subtask name"
                  autoComplete="off"
                />
              </div>
            ) : (
              <button
                ref={addSubtaskRowRef}
                type="button"
                className="subtask-add-row"
                onClick={openSubtaskBox}
              >
                <Plus size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
                <span>Add subtask</span>
              </button>
            ))}
            {subtasks.length > 0 && !data.task.untrustedText && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={handleSaveAsChecklist}
                  disabled={offline || local || checklistBusy}
                >
                  {checklistBusy ? 'Saving…' : 'Save as checklist'}
                </button>
                <span role="status" style={{ fontSize: 13, color: 'var(--t2)' }}>{checklistNotice}</span>
              </div>
            )}
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
                      ref={recurrenceRef}
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

          <ThreadSection task={data.task} refreshKey={loadSeq} onOpenTask={onOpenTask} />
        </>
      )}
    </div>
  )
}
