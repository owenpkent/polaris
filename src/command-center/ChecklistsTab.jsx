import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2 } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { useOffline } from './offlineStatus'
import NotConnected from './NotConnected'
import TaskDetailPanel from './TaskDetailPanel'
import { ConfirmButton, EmptyState, ErrorBanner, Loading } from './shared'
import { useRequestGuard } from './useRequestGuard'

// Reusable checklists: a packing list, a cleaning routine. Each one is a template, filled in once.
// Start makes a fresh task with one subtask per item and opens it; the template stays as it was,
// so it can be started again. Ticking an item is completing a subtask in the task panel. Every
// write here is live only (there is no checklist op kind in the outbox), so each control that
// writes is off while the server cannot be reached.

const MAX_ITEMS = 200

function itemsLabel(items) {
  const n = items.length
  if (n === 0) return 'No items yet'
  return `${n} ${n === 1 ? 'item' : 'items'}`
}

function itemsPreview(items) {
  if (items.length === 0) return ''
  const shown = items.slice(0, 3).join(', ')
  return items.length > 3 ? `${shown} and ${items.length - 3} more` : shown
}

let nextKey = 0
const keyed = (text) => ({ key: `item-${++nextKey}`, text })

function ChecklistForm({ checklist, onSave, onDelete, onCancel }) {
  const offline = useOffline()
  const isNew = !checklist
  const idBase = `checklist-${isNew ? 'new' : checklist.id}`
  const [name, setName] = useState(checklist?.name || '')
  const [notes, setNotes] = useState(checklist?.notes || '')
  const [items, setItems] = useState(() => (checklist?.items || []).map(keyed))
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRefs = useRef(new Map())
  const newItemRef = useRef(null)
  // After a removal, focus goes to the item now in that place, or to New item when none is left.
  const focusAfterRemove = useRef(null)

  useEffect(() => {
    if (focusAfterRemove.current === null) return
    const index = focusAfterRemove.current
    focusAfterRemove.current = null
    const target = items[Math.min(index, items.length - 1)]
    if (target) inputRefs.current.get(target.key)?.focus()
    else newItemRef.current?.focus()
  }, [items])

  const addItem = () => {
    const text = draft.trim()
    if (!text || items.length >= MAX_ITEMS) return
    setItems((list) => [...list, keyed(text)])
    setDraft('')
    newItemRef.current?.focus()
  }

  const move = (index, delta) => {
    setItems((list) => {
      const next = [...list]
      const [item] = next.splice(index, 1)
      next.splice(index + delta, 0, item)
      return next
    })
  }

  const remove = (index) => {
    focusAfterRemove.current = index
    setItems((list) => list.filter((_, i) => i !== index))
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    // A typed item that was never added with the button is still meant to be on the list.
    const texts = [...items.map((i) => i.text.trim()), draft.trim()].filter(Boolean)
    setBusy(true)
    setError(null)
    try {
      if (isNew) {
        const payload = { name: name.trim(), items: texts }
        if (notes.trim()) payload.notes = notes
        await onSave(payload)
      } else {
        const patch = {}
        if (name.trim() !== checklist.name) patch.name = name.trim()
        if (notes !== checklist.notes) patch.notes = notes
        if (JSON.stringify(texts) !== JSON.stringify(checklist.items)) patch.items = texts
        if (Object.keys(patch).length === 0) {
          setBusy(false)
          onCancel()
          return
        }
        await onSave(patch)
      }
    } catch (err) {
      setError(err.message || 'Could not save that checklist.')
      setBusy(false)
    }
  }

  const del = async () => {
    setBusy(true)
    setError(null)
    try {
      await onDelete()
    } catch (err) {
      setError(err.message || 'Could not delete that checklist.')
      setBusy(false)
    }
  }

  return (
    <form
      className="surface checklist-form"
      aria-label={isNew ? 'New checklist' : `Edit ${checklist.name}`}
      onSubmit={submit}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}
    >
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`${idBase}-name`}>Name</label>
        <input
          id={`${idBase}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Packing: weekend trip"
          maxLength={200}
          autoFocus
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`${idBase}-notes`}>Notes</label>
        <textarea
          id={`${idBase}-notes`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          style={{ padding: '10px 12px' }}
        />
        <p className="checklist-hint">Copied to every task started from this checklist.</p>
      </div>

      <fieldset className="checklist-items">
        <legend className="field-label">Items</legend>
        {items.length === 0 && <p className="checklist-hint">No items yet. Add the first one below.</p>}
        {items.length > 0 && (
          <ol className="checklist-item-list">
            {items.map((item, index) => (
              <li key={item.key} className="checklist-item">
                <input
                  ref={(el) => { if (el) inputRefs.current.set(item.key, el); else inputRefs.current.delete(item.key) }}
                  aria-label={`Item ${index + 1}`}
                  value={item.text}
                  maxLength={500}
                  onChange={(e) => {
                    const { value } = e.target
                    setItems((list) => list.map((it) => (it.key === item.key ? { ...it, text: value } : it)))
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); newItemRef.current?.focus() } }}
                />
                <button type="button" className="icon-btn" aria-label={`Move item ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp size={18} aria-hidden="true" />
                </button>
                <button type="button" className="icon-btn" aria-label={`Move item ${index + 1} down`} disabled={index === items.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown size={18} aria-hidden="true" />
                </button>
                <button type="button" className="icon-btn is-danger" aria-label={`Remove item ${index + 1}`} onClick={() => remove(index)}>
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="checklist-add">
          <input
            ref={newItemRef}
            id={`${idBase}-new-item`}
            aria-label="New item"
            placeholder="Add an item"
            value={draft}
            maxLength={500}
            disabled={items.length >= MAX_ITEMS}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem() } }}
          />
          <button type="button" className="btn" onClick={addItem} disabled={!draft.trim() || items.length >= MAX_ITEMS}>
            <Plus size={18} aria-hidden="true" /> Add item
          </button>
        </div>
        {items.length >= MAX_ITEMS && <p className="checklist-hint">A checklist holds at most {MAX_ITEMS} items.</p>}
      </fieldset>

      {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 14 }}>{error}</div>}

      <div className="checklist-actions">
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy || offline}>Save</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        {!isNew && (
          <ConfirmButton label="Delete checklist" confirmLabel="Delete checklist" onConfirm={del} disabled={busy || offline} className="btn btn-danger" />
        )}
      </div>
      {!isNew && <p className="checklist-hint">Deleting a checklist leaves the tasks started from it as they are.</p>}
    </form>
  )
}

function StartForm({ checklist, projects, onStart, onCancel }) {
  const offline = useOffline()
  const idBase = `checklist-start-${checklist.id}`
  const [title, setTitle] = useState(checklist.name)
  const [dueAt, setDueAt] = useState('')
  const [projectId, setProjectId] = useState('')
  // On by default: a repeat of the started task gets fresh copies of its items.
  const [repeatItems, setRepeatItems] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const payload = {}
      if (title.trim() && title.trim() !== checklist.name) payload.title = title.trim()
      if (dueAt) payload.dueAt = dueAt
      if (projectId) payload.projectId = projectId
      if (!repeatItems) payload.repeatItems = false
      await onStart(payload)
    } catch (err) {
      setError(err.message || 'Could not start that checklist.')
      setBusy(false)
    }
  }

  return (
    <form
      className="surface checklist-form"
      aria-label={`Start ${checklist.name}`}
      onSubmit={submit}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}
    >
      <p className="checklist-hint" style={{ fontSize: 14 }}>
        Makes a new task with {itemsLabel(checklist.items).toLowerCase()} to tick off. The checklist stays as it is.
      </p>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`${idBase}-title`}>Task title</label>
        <input id={`${idBase}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} style={{ minHeight: 44, padding: '0 12px' }} />
      </div>
      <div className="checklist-start-fields">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`${idBase}-due`}>Due date (optional)</label>
          <input id={`${idBase}-due`} type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} style={{ minHeight: 44, padding: '0 12px' }} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`${idBase}-project`}>Project (optional)</label>
          <select id={`${idBase}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ minHeight: 44, padding: '0 12px' }}>
            <option value="">No project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="checklist-check" htmlFor={`${idBase}-repeat`}>
          <input id={`${idBase}-repeat`} type="checkbox" checked={repeatItems} onChange={(e) => setRepeatItems(e.target.checked)} aria-describedby={`${idBase}-repeat-hint`} />
          Bring the items back each time it repeats
        </label>
        <p id={`${idBase}-repeat-hint`} className="checklist-hint">If you make the task repeat, each new occurrence gets its items again, unticked.</p>
      </div>

      {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 14 }}>{error}</div>}

      <div className="checklist-actions">
        <button type="submit" className="btn btn-primary" autoFocus disabled={busy || offline || checklist.items.length === 0}>Start</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

function ChecklistRow({ checklist, index, onStart, onEdit }) {
  const offline = useOffline()
  return (
    <article className={`checklist-row hover-surface${index % 2 === 1 ? ' is-striped' : ''}`} aria-label={checklist.name}>
      <div className="checklist-name">
        <span>{checklist.name}</span>
        <span className="checklist-meta">
          {itemsLabel(checklist.items)}
          {checklist.items.length > 0 && <span className="checklist-preview">: {itemsPreview(checklist.items)}</span>}
        </span>
      </div>
      <div className="checklist-row-actions">
        <button
          type="button"
          className="btn btn-primary"
          aria-label={`Start ${checklist.name}`}
          disabled={offline || checklist.items.length === 0}
          onClick={(e) => onStart(checklist, e)}
        >
          Start
        </button>
        <button type="button" className="btn" aria-label={`Edit ${checklist.name}`} disabled={offline} onClick={(e) => onEdit(checklist, e)}>
          Edit
        </button>
      </div>
    </article>
  )
}

export default function ChecklistsTab() {
  const { connected, api } = useConnection()
  const offline = useOffline()
  const [checklists, setChecklists] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // null, 'new', or the checklist being edited
  const [starting, setStarting] = useState(null) // the checklist whose Start form is open
  const [projects, setProjects] = useState([])
  const [started, setStarted] = useState(null) // { task, count } after a start
  const [detailTaskId, setDetailTaskId] = useState(null)
  const openerRef = useRef(null)
  const openTaskRef = useRef(null)
  const newButtonRef = useRef(null)
  const panelOpen = editing !== null || starting !== null
  const prevPanelOpen = useRef(false)

  const beginRequest = useRequestGuard()
  const fetchChecklists = useCallback(async () => {
    const isCurrent = beginRequest()
    try {
      const res = await api.listChecklists()
      if (!isCurrent()) return
      setChecklists(res.checklists || [])
      setError(null)
    } catch (err) {
      if (isCurrent()) setError(err.message || 'Could not load checklists.')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [api, beginRequest])

  useEffect(() => {
    if (!connected) return
    setLoading(true)
    fetchChecklists()
  }, [connected, fetchChecklists])

  // The poll waits while a form is open, so a change made elsewhere never resets what is being
  // typed. Every save refetches on its own, so nothing is lost.
  useEventRefresh(fetchChecklists, { enabled: connected && !panelOpen })

  // Esc, Cancel, and Save all close the form; focus goes back to the button that opened it,
  // unless a start just opened the new task, which takes focus itself.
  useEffect(() => {
    if (prevPanelOpen.current && !panelOpen && !detailTaskId) openerRef.current?.focus()
    prevPanelOpen.current = panelOpen
  }, [panelOpen, detailTaskId])

  const openNew = (e) => {
    openerRef.current = e.currentTarget
    setStarting(null)
    setEditing('new')
  }
  const openEdit = (checklist, e) => {
    openerRef.current = e.currentTarget
    setStarting(null)
    setEditing(checklist)
  }
  const openStart = (checklist, e) => {
    openerRef.current = e.currentTarget
    setEditing(null)
    setStarting(checklist)
    api.listProjects().then((res) => setProjects(res.projects || [])).catch(() => setProjects([]))
  }

  const handleSave = useCallback(async (payload) => {
    if (editing === 'new') await api.createChecklist(payload)
    else await api.updateChecklist(editing.id, payload)
    setEditing(null)
    await fetchChecklists()
  }, [api, editing, fetchChecklists])

  const handleDelete = useCallback(async () => {
    await api.deleteChecklist(editing.id)
    // Its Edit button goes with it, so focus lands on New checklist instead.
    openerRef.current = newButtonRef.current
    setEditing(null)
    await fetchChecklists()
  }, [api, editing, fetchChecklists])

  const handleStart = useCallback(async (payload) => {
    const res = await api.startChecklist(starting.id, payload)
    setStarting(null)
    setStarted({ task: res.task, count: (res.subtasks || []).length })
    setDetailTaskId(res.task.id)
  }, [api, starting])

  const closeTask = () => {
    setDetailTaskId(null)
    // The panel's own opener was the Start button, which is gone by now.
    requestAnimationFrame(() => openTaskRef.current?.focus())
  }

  if (!connected) return <NotConnected />

  return (
    <div className="checklists-page">
      <div className="checklists-toolbar" role="toolbar" aria-label="Checklists">
        <button ref={newButtonRef} type="button" className="btn btn-primary" disabled={offline} onClick={openNew}>
          <Plus size={18} aria-hidden="true" /> New checklist
        </button>
        {checklists.length > 0 && (
          <span className="checklists-summary">
            {checklists.length} {checklists.length === 1 ? 'checklist' : 'checklists'}
          </span>
        )}
      </div>

      {started && (
        <div className="surface checklist-started" role="status">
          <span>Started {started.task.title} with {started.count} {started.count === 1 ? 'item' : 'items'}.</span>
          <button ref={openTaskRef} type="button" className="btn" onClick={() => setDetailTaskId(started.task.id)}>
            Open task
          </button>
        </div>
      )}

      {editing === 'new' && <ChecklistForm checklist={null} onSave={handleSave} onCancel={() => setEditing(null)} />}

      <ErrorBanner message={error} onRetry={fetchChecklists} />

      {loading ? (
        <Loading label="Loading checklists…" />
      ) : checklists.length === 0 ? (
        <EmptyState icon={ListChecks} title="No checklists yet" hint="Make one for anything you do again and again, like packing or cleaning." />
      ) : (
        <div className="surface flush-last checklist-list">
          {checklists.map((checklist, index) => (
            <Fragment key={checklist.id}>
              <ChecklistRow checklist={checklist} index={index} onStart={openStart} onEdit={openEdit} />
              {editing && editing !== 'new' && editing.id === checklist.id && (
                <ChecklistForm checklist={checklist} onSave={handleSave} onDelete={handleDelete} onCancel={() => setEditing(null)} />
              )}
              {starting && starting.id === checklist.id && (
                <StartForm checklist={checklist} projects={projects} onStart={handleStart} onCancel={() => setStarting(null)} />
              )}
            </Fragment>
          ))}
        </div>
      )}

      {detailTaskId && (
        <TaskDetailPanel taskId={detailTaskId} onClose={closeTask} onOpenTask={setDetailTaskId} />
      )}
    </div>
  )
}
