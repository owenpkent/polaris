import { useEffect, useId, useState } from 'react'
import { useConnection } from './ConnectionContext'
import { useOffline } from './offlineStatus'
import { ErrorBanner, formatDate } from './shared'

// The server takes 1 MiB of JSON per request (POST /api/tasks/import), so stay under it with room for escaping.
const MAX_CHARS = 900_000
// The preview lists this many rows; the count above it covers the rest.
const PREVIEW_ROWS = 100

const FORMATS = [
  ['auto', 'Detect automatically'],
  ['csv', 'CSV with a header row'],
  ['lines', 'One task per line'],
]

// How deep a row sits under its parents, for indenting subtasks in the preview.
function depthOf(rows, index) {
  let depth = 0
  let parent = rows[index]?.parentIndex
  while (parent !== null && parent !== undefined && depth < 10) {
    depth += 1
    parent = rows[parent]?.parentIndex
  }
  return depth
}

function rowMeta(row) {
  const parts = []
  if (row.projectName || row.projectSlug || row.project) parts.push(row.projectName || row.projectSlug || row.project)
  if (row.sectionName || row.section) parts.push(row.sectionName || row.section)
  if (row.dueAt) parts.push(`due ${formatDate(row.dueAt)}`)
  if (row.priority && row.priority !== 'none') parts.push(row.priority)
  if (row.status && row.status !== 'open') parts.push(row.status.replace('_', ' '))
  return parts.join(' · ')
}

// Bulk import from pasted text or a file: preview first (a dry run on the server, so every
// column, project, and date is checked exactly as the real import checks it), then create all
// of it in one go. Live only: there is no offline op kind for this, so it is disabled offline.
export default function ImportTasks() {
  const { connected, api } = useConnection()
  const offline = useOffline()
  const ids = useId()
  const [text, setText] = useState('')
  const [format, setFormat] = useState('auto')
  const [project, setProject] = useState('')
  const [projects, setProjects] = useState([])
  const [preview, setPreview] = useState(null)
  const [previewKey, setPreviewKey] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  useEffect(() => {
    if (!connected) return undefined
    let cancelled = false
    api.listProjects()
      .then((res) => { if (!cancelled) setProjects(res?.projects || []) })
      .catch(() => { if (!cancelled) setProjects([]) })
    return () => { cancelled = true }
  }, [connected, api])

  if (!connected) {
    return (
      <section className="card" aria-labelledby="cc-import-heading">
        <div className="section-header" id="cc-import-heading">Import tasks</div>
        <p className="settings-hint" style={{ margin: 0 }}>Connect to a server to import tasks.</p>
      </section>
    )
  }

  const key = JSON.stringify([text, format, project])
  const fresh = preview && previewKey === key
  const rows = fresh ? preview.rows || [] : []
  const errors = fresh ? preview.errors || [] : []
  const canImport = fresh && rows.length > 0 && errors.length === 0 && !busy && !offline

  function body(dryRun) {
    return { text, format, ...(project ? { project } : {}), dryRun }
  }

  async function runPreview(e) {
    e?.preventDefault()
    setError(null)
    setDone(null)
    if (!text.trim()) {
      setError('Paste some tasks or choose a file first.')
      return
    }
    setBusy(true)
    try {
      const res = await api.importTasks(body(true))
      setPreview(res)
      setPreviewKey(key)
    } catch (err) {
      setPreview(null)
      setError(err.message || 'Could not read that text.')
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    setError(null)
    setBusy(true)
    try {
      const res = await api.importTasks(body(false))
      const count = res?.count ?? res?.created?.length ?? rows.length
      setDone(`Imported ${count} ${count === 1 ? 'task' : 'tasks'}.`)
      setText('')
      setPreview(null)
      setPreviewKey(null)
    } catch (err) {
      setError(err.message || 'The import failed. Nothing was created.')
    } finally {
      setBusy(false)
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setDone(null)
    try {
      const content = await file.text()
      if (content.length > MAX_CHARS) {
        setError(`${file.name} is too large to import at once. Split it into smaller files.`)
        return
      }
      setText(content)
      // A .csv or .tsv file is a table whatever its first line looks like.
      if (/\.(csv|tsv)$/i.test(file.name)) setFormat('csv')
    } catch {
      setError(`Could not read ${file.name}.`)
    }
  }

  return (
    <section className="card" aria-labelledby="cc-import-heading">
      <div className="section-header" id="cc-import-heading">Import tasks</div>
      <p className="settings-hint">
        Paste a list with one task per line (indent a line to make it a subtask, and <code>[x]</code> marks one done),
        or a CSV with a header row. CSV columns: title, notes, status, priority, due, start, estimate, assignee,
        project, section. Only title is required, and a project column overrides the project picked below. You see a
        preview before anything is created.
      </p>

      <form onSubmit={runPreview}>
        <div className="field">
          <label htmlFor={`${ids}-text`}>Tasks to import</label>
          <textarea
            id={`${ids}-text`}
            rows={6}
            value={text}
            maxLength={MAX_CHARS}
            onChange={(e) => { setText(e.target.value); setDone(null) }}
            placeholder={'Book the venue\n  Call three places\nSend invitations'}
            disabled={busy || offline}
            spellCheck={false}
          />
        </div>

        <div className="import-options">
          <div className="field">
            <label htmlFor={`${ids}-format`}>Format</label>
            <select id={`${ids}-format`} value={format} onChange={(e) => setFormat(e.target.value)} disabled={busy || offline}>
              {FORMATS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>

          <div className="field">
            <label htmlFor={`${ids}-project`}>Project</label>
            <select id={`${ids}-project`} value={project} onChange={(e) => setProject(e.target.value)} disabled={busy || offline}>
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.slug || p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <label className="btn file-pick" style={{ cursor: offline ? 'default' : 'pointer' }}>
            Choose a file
            <input
              type="file"
              accept=".csv,.tsv,.txt,.md,text/csv,text/plain,text/markdown,text/tab-separated-values"
              onChange={onFile}
              disabled={busy || offline}
              className="sr-only"
            />
          </label>
          <button type="submit" className="btn" disabled={busy || offline || !text.trim()}>
            {busy && !fresh ? 'Checking…' : 'Preview'}
          </button>
          <button type="button" className="btn btn-primary" disabled={!canImport} onClick={runImport}>
            {fresh && rows.length > 0 ? `Import ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}` : 'Import'}
          </button>
        </div>
      </form>

      {error && <ErrorBanner message={error} />}
      {done && <div role="status" className="import-done">{done}</div>}
      {preview && !fresh && !error && (
        <p className="settings-hint">The text changed since the preview. Preview again to import it.</p>
      )}

      {fresh && (
        <div role="region" aria-label="Import preview">
          <p className="settings-hint" style={{ marginBottom: '0.5rem' }}>
            {rows.length} {rows.length === 1 ? 'task' : 'tasks'} read as {preview.format === 'csv' ? 'CSV' : 'a list'}
            {errors.length > 0 ? `, ${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} to fix first` : ''}.
          </p>
          {preview.ignoredColumns?.length > 0 && (
            <p className="settings-hint" style={{ marginBottom: '0.5rem' }}>
              Columns left out: {preview.ignoredColumns.join(', ')}.
            </p>
          )}
          {errors.length > 0 && (
            <ul className="import-errors" aria-label="Problems">
              {errors.map((err, i) => (
                <li key={`${err.line}-${i}`}>{err.line ? `Line ${err.line}: ` : ''}{err.message}</li>
              ))}
            </ul>
          )}
          {rows.length > 0 && (
            <ul className="import-preview" aria-label="Tasks to create" tabIndex={0}>
              {rows.slice(0, PREVIEW_ROWS).map((row, i) => {
                const meta = rowMeta(row)
                return (
                  <li key={`${row.line}-${i}`} style={{ paddingLeft: `${0.75 + depthOf(rows, i) * 1.25}rem` }}>
                    <div style={{ color: 'var(--t1)', fontSize: '0.9rem' }}>{row.title}</div>
                    {meta && <div className="import-meta">{meta}</div>}
                  </li>
                )
              })}
              {rows.length > PREVIEW_ROWS && (
                <li className="import-meta">and {rows.length - PREVIEW_ROWS} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
