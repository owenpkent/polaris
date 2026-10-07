import { useState, useEffect, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { useOffline } from './offlineStatus'
import NotConnected from './NotConnected'
import { isSafeHref } from './SafeMarkdown'
import { Loading, ErrorBanner, Kbd, ProjectChip } from './shared'
import { useNarrowBreakpoints } from './columnsState'
import { useRequestGuard } from './useRequestGuard'

const GRID_TEMPLATE = 'minmax(0, 1fr) 200px 120px 220px'

const SOURCE_LABELS = { github: 'GitHub', gmail: 'Gmail', gdrive: 'Drive', gcal: 'Calendar', manual: 'Manual' }

function sourceLabel(sourceType) {
  if (!sourceType) return ''
  return SOURCE_LABELS[sourceType] || sourceType.charAt(0).toUpperCase() + sourceType.slice(1)
}

// A short second line describing what kind of item this is. Only derived from
// fields the ingestors set reliably (sourceId suffixes github adds, notes
// patterns google adds) -- never from guessing at the title text. Returns
// null when the source doesn't tell us anything concrete: a plain github
// item, for example, could be an issue or a pull request and nothing on the
// task tells us which, so we show nothing rather than guess.
// When the meta line already says why a GitHub item is here, drop the
// matching "Fix PR:" / "Review:" prefix and "(check failing: ...)" suffix
// from the displayed title so the row does not say it twice.
function displayTitle(item, meta) {
  if (item.sourceType !== 'github' || !meta) return item.title
  return item.title
    .replace(/^(Fix PR|Review):\s*/, '')
    .replace(/\s*\(check failing: .*\)$/, '')
}

function deriveMeta(item) {
  const sourceId = item.sourceId || ''
  const notes = item.notes || ''
  switch (item.sourceType) {
    case 'github':
      if (sourceId.endsWith(':review')) return 'Review requested'
      if (sourceId.endsWith(':attention')) {
        const m = notes.match(/Needs attention: (.+)/)
        return m ? `Your pull request: ${m[1].trim()}` : 'Your pull request needs attention'
      }
      return null
    case 'gmail':
      return 'Email'
    case 'gdrive': {
      const m = notes.match(/^From "(.+)"\.$/)
      return m ? `From "${m[1]}"` : 'Drive document'
    }
    case 'gcal':
      return 'Calendar event'
    default:
      return null
  }
}

const SHORTCUTS = [
  ['j / k', 'Move selection'],
  ['a', 'Accept selected'],
  ['r', 'Reject selected'],
  ['Esc', 'Cancel the open form'],
  ['?', 'Toggle this help'],
]

function ShortcutsDialog({ onClose }) {
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Inbox keyboard shortcuts" style={{ maxWidth: 360 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div className="section-header" style={{ marginBottom: 0 }}>Keyboard shortcuts</div>
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {SHORTCUTS.map(([key, label]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
              <Kbd>{key}</Kbd>
              <span style={{ color: 'var(--t2)', fontSize: '0.875rem' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const fieldLabelStyle = { fontSize: 13, color: 'var(--t2)', marginBottom: 6 }

const controlStyle = {
  display: 'block',
  width: '100%',
  height: 44,
  boxSizing: 'border-box',
  padding: '0 12px',
  border: '1px solid var(--bd-strong)',
  borderRadius: 8,
  background: 'var(--bg-inset)',
  color: 'var(--t1)',
  fontSize: 14,
  fontFamily: 'inherit',
}

const cancelBtnStyle = {
  height: 44,
  boxSizing: 'border-box',
  padding: '0 18px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--t2)',
  fontSize: 14,
}

const acceptAsTaskBtnStyle = {
  height: 44,
  boxSizing: 'border-box',
  padding: '0 18px',
  border: 'none',
  borderRadius: 8,
  background: 'var(--blue)',
  color: 'var(--on-accent)',
  fontSize: 14,
  fontWeight: 600,
}

const confirmRejectBtnStyle = {
  height: 44,
  boxSizing: 'border-box',
  padding: '0 18px',
  border: '1px solid var(--red)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--red)',
  fontSize: 14,
}

function AcceptFormRow({ item, projects, onAccept, onCancel, busy, error }) {
  const offline = useOffline()
  const [project, setProject] = useState(item.projectId || '')
  const [dueAt, setDueAt] = useState(item.dueAt ? item.dueAt.slice(0, 10) : '')
  const [priority, setPriority] = useState(item.priority || 'none')
  const [title, setTitle] = useState(() => displayTitle(item, deriveMeta(item)))

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="inbox-form-stack">
    <div>
      <div style={fieldLabelStyle}>Task name</div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task name" style={controlStyle} />
    </div>
    <div className="inbox-form-fields">
      <div>
        <div style={fieldLabelStyle}>Project</div>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" style={controlStyle}>
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div>
        <div style={fieldLabelStyle}>Due date</div>
        <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} aria-label="Due date" style={controlStyle} />
      </div>
      <div>
        <div style={fieldLabelStyle}>Priority</div>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority" style={controlStyle}>
          <option value="none">None</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
      </div>
      <div className="inbox-form-actions">
        {error && <span style={{ fontSize: 13, color: 'var(--red)', marginRight: 4 }}>{error}</span>}
        <button type="button" onClick={onCancel} disabled={busy} style={cancelBtnStyle}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !title.trim() || offline}
          style={acceptAsTaskBtnStyle}
          onClick={() => onAccept({ title: title.trim(), project: project || undefined, dueAt: dueAt || undefined, priority })}
        >
          Accept as task
        </button>
      </div>
    </div>
    </div>
  )
}

function RejectFormRow({ onConfirm, onCancel, busy, error }) {
  const offline = useOffline()
  const [reason, setReason] = useState('')

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="inbox-reject-fields">
      <div>
        <div style={fieldLabelStyle}>Reason (optional)</div>
        <textarea
          rows={1}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this being rejected?"
          style={{ ...controlStyle, height: 44, paddingTop: 10, resize: 'vertical' }}
        />
      </div>
      <div className="inbox-form-actions">
        {error && <span style={{ fontSize: 13, color: 'var(--red)', marginRight: 4 }}>{error}</span>}
        <button type="button" onClick={onCancel} disabled={busy} style={cancelBtnStyle}>
          Cancel
        </button>
        <button type="button" disabled={busy || offline} style={confirmRejectBtnStyle} onClick={() => onConfirm(reason.trim() || undefined)}>
          Confirm reject
        </button>
      </div>
    </div>
  )
}

function InboxRow({ item, selected, striped, stacked, expandedType, onExpand, projects, projectName, onAccept, onReject }) {
  const offline = useOffline()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function runAccept(payload) {
    setBusy(true)
    setError(null)
    try {
      await onAccept(item.id, payload)
    } catch (err) {
      setError(err.message || 'Could not accept this item.')
      setBusy(false)
    }
  }

  async function runReject(reason) {
    setBusy(true)
    setError(null)
    try {
      await onReject(item.id, reason)
    } catch (err) {
      setError(err.message || 'Could not reject this item.')
      setBusy(false)
    }
  }

  const expanded = expandedType === 'accept' || expandedType === 'reject'
  const meta = deriveMeta(item)
  const safeLink = item.sourceUrl && isSafeHref(item.sourceUrl)

  const titleStyle = { display: 'block', fontSize: 15, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

  // Shared between the desktop grid row and the stacked card so Accept/Reject
  // keep exactly the same classes, handlers, and confirmation semantics in
  // both layouts -- only their container changes.
  const actionButtons = (
    <>
      <button
        type="button"
        className="btn"
        aria-expanded={expandedType === 'reject'}
        disabled={offline}
        onClick={() => onExpand(expandedType === 'reject' ? null : 'reject')}
      >
        Reject
      </button>
      {expandedType !== 'accept' && (
        <button type="button" className="btn btn-success" aria-expanded={false} disabled={offline} onClick={() => onExpand('accept')}>
          Accept
        </button>
      )}
    </>
  )

  const row = stacked ? (
    <div
      role={expanded ? undefined : 'listitem'}
      className={`inbox-card${striped && !expanded ? ' is-striped' : ''}`}
      style={{
        borderBottom: expanded ? 'none' : undefined,
        boxShadow: selected && !expanded ? 'inset 3px 0 0 var(--blue)' : 'none',
      }}
    >
      <div>
        {safeLink ? (
          <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="inbox-card-title">
            {displayTitle(item, meta)}
          </a>
        ) : (
          <span className="inbox-card-title">{displayTitle(item, meta)}</span>
        )}
        <div className="inbox-card-meta">
          {[projectName, sourceLabel(item.sourceType)].filter(Boolean).join(' · ')}
        </div>
        {meta && <div className="inbox-card-meta">{meta}</div>}
      </div>
      <div className="inbox-card-actions">{actionButtons}</div>
    </div>
  ) : (
    <div
      role="row"
      className={striped && !expanded ? 'is-striped' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: GRID_TEMPLATE,
        alignItems: 'center',
        minHeight: 68,
        padding: '0 16px',
        borderBottom: expanded ? 'none' : '1px solid var(--bd)',
        boxShadow: selected && !expanded ? 'inset 3px 0 0 var(--blue)' : 'none',
      }}
    >
      <div role="cell" style={{ minWidth: 0, paddingRight: 16 }}>
        {safeLink ? (
          <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ ...titleStyle, textDecoration: 'none' }}>
            {displayTitle(item, meta)}
          </a>
        ) : (
          <span style={titleStyle}>{displayTitle(item, meta)}</span>
        )}
        {meta && (
          <div style={{ fontSize: 13, color: 'var(--t2)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {meta}
          </div>
        )}
      </div>
      <div role="cell" style={{ fontSize: 14, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 16 }}>
        {projectName ? <ProjectChip name={projectName} /> : ''}
      </div>
      <div role="cell" style={{ fontSize: 14, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 16 }}>
        {sourceLabel(item.sourceType)}
      </div>
      <div role="cell" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
        {actionButtons}
      </div>
    </div>
  )

  if (!expanded) return row

  // The open form must keep the list or table valid: in the stacked layout the wrapper is the
  // list item (the card above gives up that role), in the table the wrapper is a row group and the
  // form is a row with one cell spanning the columns. Otherwise axe reports aria-required-children.
  const form =
    expandedType === 'accept' ? (
      <AcceptFormRow item={item} projects={projects} busy={busy} error={error} onAccept={runAccept} onCancel={() => onExpand(null)} />
    ) : (
      <RejectFormRow busy={busy} error={error} onConfirm={runReject} onCancel={() => onExpand(null)} />
    )
  return (
    <div role={stacked ? 'listitem' : 'rowgroup'} style={{ background: 'var(--bg3)', borderBottom: '1px solid var(--bd)' }}>
      {row}
      {stacked ? (
        form
      ) : (
        <div role="row">
          <div role="cell" aria-colspan={4}>
            {form}
          </div>
        </div>
      )}
    </div>
  )
}

export default function InboxTab() {
  const { connected, api } = useConnection()
  const offline = useOffline()
  const [items, setItems] = useState([])
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [actionState, setActionState] = useState(null) // { id, type: 'accept' | 'reject' }
  const [legendOpen, setLegendOpen] = useState(false)
  // The table's Project, Source, and action columns are fixed, and above the phone breakpoint the
  // sidebar takes 232px of the window, so the table gives way to the phone's stacked cards well
  // before the phone tier: see narrowInbox in columnsState.js.
  const { phone, narrowInbox } = useNarrowBreakpoints()
  const stacked = phone || narrowInbox

  const beginRequest = useRequestGuard()
  const fetchInbox = useCallback(async () => {
    const isCurrent = beginRequest()
    setError(null)
    try {
      const res = await api.listInbox()
      if (isCurrent()) setItems(res.tasks || [])
    } catch (err) {
      if (isCurrent()) setError(err.message || 'Could not load the inbox.')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [api, beginRequest])

  useEffect(() => {
    if (!connected) return
    setLoading(true)
    fetchInbox()
  }, [connected, fetchInbox])

  useEffect(() => {
    if (!connected) return
    api.listProjects().then((res) => setProjects(res.projects || [])).catch(() => {})
  }, [connected, api])

  useEventRefresh(fetchInbox, { enabled: connected })

  useEffect(() => {
    if (selectedIndex > items.length - 1) setSelectedIndex(Math.max(0, items.length - 1))
  }, [items, selectedIndex])

  const projectNameById = useMemo(() => {
    const map = new Map()
    for (const p of projects) map.set(p.id, p.name)
    return map
  }, [projects])

  const handleAccept = useCallback(async (id, payload) => {
    await api.acceptInboxItem(id, payload)
    setActionState(null)
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [api])

  const handleReject = useCallback(async (id, reason) => {
    await api.rejectInboxItem(id, reason ? { reason } : {})
    setActionState(null)
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [api])

  // j/k/a/r shortcuts, ignored while the user is typing in a form control.
  useEffect(() => {
    function onKeyDown(e) {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      // A single-letter shortcut is the bare letter only. Without this, Ctrl+R opened the reject
      // form and swallowed the reload, and Ctrl+A opened the accept form instead of selecting the
      // page, because the handler matched e.key and then called preventDefault.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (items.length === 0) return

      if (e.key === 'j') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(items.length - 1, i + 1))
      } else if (e.key === 'k') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(0, i - 1))
      } else if (e.key === 'a') {
        e.preventDefault()
        if (offline) return
        const item = items[selectedIndex]
        if (item) setActionState((prev) => (prev?.id === item.id && prev.type === 'accept' ? null : { id: item.id, type: 'accept' }))
      } else if (e.key === 'r') {
        e.preventDefault()
        if (offline) return
        const item = items[selectedIndex]
        if (item) setActionState((prev) => (prev?.id === item.id && prev.type === 'reject' ? null : { id: item.id, type: 'reject' }))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [items, selectedIndex, offline])

  // "?" toggles the shortcuts dialog; Esc (handled here regardless of focus,
  // so it also works while a select/input inside an open form is focused)
  // closes the open accept/reject form.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === '?') {
        const tag = (e.target?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return
        e.preventDefault()
        setLegendOpen((v) => !v)
      } else if (e.key === 'Escape') {
        setActionState((prev) => (prev ? null : prev))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!connected) return <NotConnected />

  return (
    <div>
      <ErrorBanner message={error} onRetry={fetchInbox} />

      {loading ? (
        <Loading label="Loading inbox…" />
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', height: 72, fontSize: 14, color: 'var(--t2)' }}>
            Suggested tasks from GitHub. Nothing becomes a task until you accept it.
          </div>

          {items.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 0', color: 'var(--t2)', fontSize: 14 }}>Inbox is empty.</div>
          ) : (
            <div role={stacked ? 'list' : 'table'} aria-label="Inbox" className="surface flush-last" style={{ overflow: stacked ? undefined : 'hidden' }}>
              {!stacked && (
                <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID_TEMPLATE, height: 44, alignItems: 'center', padding: '0 16px', background: 'var(--bg3)', borderBottom: '1px solid var(--bd-surface)' }}>
                  <div role="columnheader" style={{ fontSize: 13, color: 'var(--t2)', paddingRight: 16 }}>Name</div>
                  <div role="columnheader" style={{ fontSize: 13, color: 'var(--t2)', paddingRight: 16 }}>Project</div>
                  <div role="columnheader" style={{ fontSize: 13, color: 'var(--t2)', paddingRight: 16 }}>Source</div>
                  <div role="columnheader" />
                </div>
              )}

              {items.map((item, index) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  selected={index === selectedIndex}
                  striped={index % 2 === 1}
                  stacked={stacked}
                  expandedType={actionState?.id === item.id ? actionState.type : null}
                  onExpand={(type) => setActionState(type ? { id: item.id, type } : null)}
                  projects={projects}
                  projectName={item.projectId ? projectNameById.get(item.projectId) : ''}
                  onAccept={handleAccept}
                  onReject={handleReject}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {legendOpen && <ShortcutsDialog onClose={() => setLegendOpen(false)} />}
    </div>
  )
}
