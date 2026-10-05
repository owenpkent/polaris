import { useCallback, useEffect, useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import NotConnected from './NotConnected'
import TaskDetailPanel from './TaskDetailPanel'
import { EmptyState, ErrorBanner, Loading } from './shared'

// Every thread at a glance (docs/agent-threads-proposal.md, stage 2): what is still claimed, what
// nobody has answered, what the owner has accepted, and how long since the last verdict. The
// owner is the control component here, in the blackboard sense: this page is where a stalled
// thread shows itself. Reading only; every judgement is made in the task panel.

const DAY_MS = 24 * 60 * 60 * 1000

// Whole days from `iso` to now, never negative. A thread with no verdict yet counts from its start.
export function daysSince(iso, now = Date.now()) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now - t) / DAY_MS))
}

function Figure({ label, value, warn }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 96 }}>
      <span style={{ fontSize: 18, fontWeight: 600, color: warn ? 'var(--orange)' : 'var(--t1)' }}>{value}</span>
      <span style={{ fontSize: 12, color: 'var(--t2)' }}>{label}</span>
    </div>
  )
}

function ThreadRow({ row, onOpenTask }) {
  const days = daysSince(row.lastProgressAt)
  return (
    <article className="card" aria-label={row.thread.title} style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px' }}>
          {row.thread.title !== row.taskTitle && (
            <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: '0.3rem' }}>{row.thread.title}</div>
          )}
          <button type="button" className="btn btn-ghost" style={{ marginLeft: -10 }} onClick={() => onOpenTask(row.thread.taskId)}>
            Open {row.taskTitle}
          </button>
        </div>
        <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
          <Figure label="Open claims" value={row.openClaims} />
          <Figure label="Unanswered objections" value={row.unansweredObjections} warn={row.unansweredObjections > 0} />
          <Figure label="Accepted results" value={row.acceptedResults} />
          <Figure label="Days since progress" value={days ?? 0} warn={days != null && days >= 7} />
        </div>
      </div>
    </article>
  )
}

export default function ThreadsTab() {
  const { connected, api } = useConnection()
  const [status, setStatus] = useState('open')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [detailTaskId, setDetailTaskId] = useState(null)

  const fetchThreads = useCallback(async () => {
    setError(null)
    try {
      const res = await api.getThreads(status)
      setRows(res.threads || [])
    } catch (err) {
      setError(err.message || 'Could not load threads.')
    } finally {
      setLoading(false)
    }
  }, [api, status])

  useEffect(() => {
    if (!connected) return
    setLoading(true)
    fetchThreads()
  }, [connected, fetchThreads])

  useEventRefresh(fetchThreads, { enabled: connected })

  if (!connected) return <NotConnected />

  return (
    <div>
      <div role="group" aria-label="Which threads" style={{ display: 'flex', gap: 6, marginBottom: '1.25rem' }}>
        <button type="button" className="btn" aria-pressed={status === 'open'} onClick={() => setStatus('open')}>Open threads</button>
        <button type="button" className="btn" aria-pressed={status === 'closed'} onClick={() => setStatus('closed')}>Closed threads</button>
      </div>

      <ErrorBanner message={error} onRetry={fetchThreads} />

      {loading ? (
        <Loading label="Loading threads…" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title={status === 'open' ? 'No open threads' : 'No closed threads'}
          hint="A thread starts from a task's panel, under Thread."
        />
      ) : (
        rows.map((row) => <ThreadRow key={row.thread.id} row={row} onOpenTask={setDetailTaskId} />)
      )}

      {detailTaskId && (
        <TaskDetailPanel
          taskId={detailTaskId}
          onClose={() => setDetailTaskId(null)}
          onChanged={fetchThreads}
          onOpenTask={setDetailTaskId}
        />
      )}
    </div>
  )
}
