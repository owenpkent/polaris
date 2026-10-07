import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Folder, Plus } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { useOffline } from './offlineStatus'
import NotConnected from './NotConnected'
import { EmptyState, ErrorBanner, Loading, ProjectAvatar } from './shared'
import { useRequestGuard } from './useRequestGuard'

// Projects are made by hand in this tab, or created from a tracked GitHub repo on the dashboard's
// GitHub page (see GithubTab.jsx). Every field here is editable.

function fieldText(value, placeholder) {
  return value && String(value).trim() ? value : placeholder
}

// The store keeps github as a full https://github.com/owner/repo URL (see schemas.ts). The list
// and the edit field both show the short owner/repo form the user is more likely to have typed.
function githubOwnerRepo(github) {
  if (!github) return null
  const m = String(github).match(/github\.com[/:]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}` : github
}

function openTasksLabel(counts) {
  const n = counts?.open ?? 0
  return `${n} open ${n === 1 ? 'task' : 'tasks'}`
}

// A type the badge classes in index.css know (software, media, ...) gets its tint; any other
// text, which the owner can type freely, gets the neutral one.
const TYPE_BADGES = ['software', 'media', 'hardware', 'business', 'planning']
function typeBadgeClass(type) {
  const key = String(type || '').trim().split(/[\s/]+/)[0].toLowerCase()
  return TYPE_BADGES.includes(key) ? `badge badge-${key}` : 'badge badge-neutral'
}

// The status dot: green for an active project, yellow while it is being set up, grey otherwise.
function statusDotClass(status) {
  const key = String(status || '').trim().toLowerCase()
  if (key === 'active' || key === 'stable') return 'status-dot dot-active'
  if (key === 'development' || key === 'planning') return `status-dot dot-${key}`
  return 'status-dot'
}

// Compares a draft field to the project's current value and, only if it changed, adds it to
// `patch` -- so a save sends just what changed. An emptied optional field is sent as null so the
// server clears it rather than storing an empty string; `required` fields (Name) are never
// cleared this way, since the Save button is already disabled while Name is blank.
function diffField(patch, key, value, original, { required = false } = {}) {
  const next = value.trim()
  const orig = (original ?? '').toString()
  if (next === orig) return
  if (required) {
    if (next) patch[key] = next
    return
  }
  patch[key] = next === '' ? null : next
}

function ProjectForm({ project, onSave, onArchive, onCancel }) {
  const offline = useOffline()
  const isNew = !project
  const fieldId = (name) => `project-${name}-${isNew ? 'new' : project.id}`
  const label = isNew ? 'New project' : `Edit ${project.name}`

  const [name, setName] = useState(project?.name || '')
  const [type, setType] = useState(project?.type || '')
  const [status, setStatus] = useState(project?.status || '')
  const [github, setGithub] = useState(githubOwnerRepo(project?.github) || '')
  const [description, setDescription] = useState(project?.description || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      if (isNew) {
        const payload = { name: name.trim() }
        if (type.trim()) payload.type = type.trim()
        if (status.trim()) payload.status = status.trim()
        if (github.trim()) payload.github = github.trim()
        if (description.trim()) payload.description = description
        await onSave(payload)
      } else {
        const patch = {}
        diffField(patch, 'name', name, project.name, { required: true })
        diffField(patch, 'type', type, project.type)
        diffField(patch, 'status', status, project.status)
        diffField(patch, 'github', github, githubOwnerRepo(project.github))
        diffField(patch, 'description', description, project.description)
        if (Object.keys(patch).length === 0) {
          setBusy(false)
          onCancel()
          return
        }
        await onSave(patch)
      }
    } catch (err) {
      setError(err.message || 'Could not save that project.')
      setBusy(false)
    }
  }

  const archive = async () => {
    setBusy(true)
    setError(null)
    try {
      await onArchive(!project.archived)
    } catch (err) {
      setError(err.message || 'Could not update that project.')
      setBusy(false)
    }
  }

  return (
    <form
      className="surface project-form"
      aria-label={label}
      onSubmit={submit}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}
    >
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={fieldId('name')}>Name</label>
        <input
          id={fieldId('name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={fieldId('type')}>Type</label>
        <input
          id={fieldId('type')}
          value={type}
          onChange={(e) => setType(e.target.value)}
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={fieldId('status')}>Status</label>
        <input
          id={fieldId('status')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={fieldId('github')}>GitHub repo</label>
        <input
          id={fieldId('github')}
          value={github}
          onChange={(e) => setGithub(e.target.value)}
          placeholder="owner/repo"
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={fieldId('description')}>Description</label>
        <textarea
          id={fieldId('description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          style={{ padding: '10px 12px' }}
        />
        <p className="project-hint">Markdown is supported.</p>
      </div>

      {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 14 }}>{error}</div>}

      <div className="project-actions">
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy || offline}>Save</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        {!isNew && (
          <button type="button" className="btn" onClick={archive} disabled={busy || offline}>
            {project.archived ? 'Unarchive' : 'Archive'}
          </button>
        )}
      </div>
    </form>
  )
}

function ProjectRow({ project, onEdit }) {
  const offline = useOffline()
  const status = fieldText(project.status, '')
  return (
    <article className="project-row" aria-label={project.name}>
      <div className="project-name">
        <ProjectAvatar name={project.name} />
        <span>{project.name}</span>
        {project.archived && <span className="badge badge-neutral">Archived</span>}
      </div>
      <div className="project-meta">
        {project.type && String(project.type).trim() ? (
          <span className={typeBadgeClass(project.type)}>{project.type}</span>
        ) : (
          <span className="project-cell">No type</span>
        )}
        <span className="project-cell project-status">
          <span className={statusDotClass(status)} style={status ? undefined : { background: 'var(--bd-strong)' }} aria-hidden="true" />
          {status || 'No status'}
        </span>
        <span className="project-cell">{githubOwnerRepo(project.github) || 'No repo'}</span>
        <span className="project-cell">{openTasksLabel(project.counts)}</span>
      </div>
      <button
        type="button"
        className="btn-ghost"
        aria-label={`Edit ${project.name}`}
        disabled={offline}
        onClick={(e) => onEdit(project, e)}
      >
        Edit
      </button>
    </article>
  )
}

export default function ProjectsTab() {
  const { connected, api } = useConnection()
  const offline = useOffline()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState(null) // null, 'new', or the project being edited
  const openerRef = useRef(null)
  const prevEditingRef = useRef(null)

  const beginRequest = useRequestGuard()
  const fetchProjects = useCallback(async () => {
    const isCurrent = beginRequest()
    try {
      const res = await api.listProjects({ includeArchived: showArchived })
      if (!isCurrent()) return
      setProjects(res.projects || [])
      setError(null)
    } catch (err) {
      if (isCurrent()) setError(err.message || 'Could not load projects.')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [api, showArchived, beginRequest])

  useEffect(() => {
    if (!connected) return
    setLoading(true)
    fetchProjects()
  }, [connected, fetchProjects])

  // Skip the poll-triggered refetch while a panel is open, so a change made elsewhere never
  // replaces the project object a Save/Cancel/Archive click is about to act on and never resets
  // fields the user is mid-typing. Save, Cancel, and Archive all refetch explicitly once they are
  // done, so this loses no updates -- it only defers them until the panel closes.
  useEventRefresh(fetchProjects, { enabled: connected && !editing })

  // Esc and Cancel both end at the same place: editing goes back to null. Whenever that happens,
  // return focus to whichever button opened the panel (NavDrawer does the same for the drawer).
  useEffect(() => {
    if (prevEditingRef.current && !editing) {
      openerRef.current?.focus()
    }
    prevEditingRef.current = editing
  }, [editing])

  const openNew = (e) => {
    openerRef.current = e.currentTarget
    setEditing('new')
  }
  const openEdit = (project, e) => {
    openerRef.current = e.currentTarget
    setEditing(project)
  }
  const closeEditor = () => setEditing(null)

  const handleSave = useCallback(async (payload) => {
    if (editing === 'new') {
      await api.createProject(payload)
    } else {
      await api.updateProject(editing.id, payload)
    }
    closeEditor()
    await fetchProjects()
  }, [api, editing, fetchProjects])

  const handleArchive = useCallback(async (project, archived) => {
    await api.updateProject(project.id, { archived })
    closeEditor()
    await fetchProjects()
  }, [api, fetchProjects])

  if (!connected) return <NotConnected />

  return (
    <div className="projects-page">
      <div className="projects-toolbar" role="toolbar" aria-label="Projects">
        <button type="button" className="btn btn-primary" disabled={offline} onClick={openNew}>
          <Plus size={18} aria-hidden="true" /> New project
        </button>
        <button type="button" className="btn" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
        {projects.length > 0 && (
          <span className="projects-summary" role="status">
            {projects.length} {projects.length === 1 ? 'project' : 'projects'}
          </span>
        )}
      </div>

      {editing === 'new' && <ProjectForm project={null} onSave={handleSave} onCancel={closeEditor} />}

      <ErrorBanner message={error} onRetry={fetchProjects} />

      {loading ? (
        <Loading label="Loading projects…" />
      ) : projects.length === 0 ? (
        <EmptyState icon={Folder} title="No projects yet" hint="Add one to start filing tasks under it." />
      ) : (
        <div className="surface flush-last project-list">
          {projects.map((project) => (
            <Fragment key={project.id}>
              <ProjectRow project={project} onEdit={openEdit} />
              {editing && editing !== 'new' && editing.id === project.id && (
                <ProjectForm
                  project={project}
                  onSave={handleSave}
                  onArchive={(archived) => handleArchive(project, archived)}
                  onCancel={closeEditor}
                />
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
