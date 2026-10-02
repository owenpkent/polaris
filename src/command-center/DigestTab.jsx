import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Play, Newspaper } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { useOffline } from './offlineStatus'
import NotConnected from './NotConnected'
import SafeMarkdown from './SafeMarkdown'
import { Loading, ErrorBanner, EmptyState } from './shared'

function SyncStrip({ jobs, onRun, running }) {
  const offline = useOffline()
  const names = Object.keys(jobs || {})
  if (names.length === 0) return null

  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <div className="section-header">Sync jobs</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
        {names.map((name) => {
          const job = jobs[name]
          return (
            <div
              key={name}
              style={{
                flex: '1 1 220px',
                background: 'var(--bg2)',
                borderRadius: 10,
                padding: '0.75rem 1rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.4rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{name}</span>
                {job.running && <span style={{ fontSize: '0.72rem', color: 'var(--yellow)' }}>Running…</span>}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--t2)' }}>
                {job.lastRunAt ? `Last run ${new Date(job.lastRunAt).toLocaleString()}` : 'Never run'}
              </div>
              {job.lastError && (
                <div style={{ fontSize: '0.75rem', color: 'var(--red)' }}>{job.lastError}</div>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => onRun(name)}
                disabled={job.running || running === name || offline}
                style={{ alignSelf: 'flex-start', padding: '0.4rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
              >
                <Play size={13} aria-hidden="true" /> Run now
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function DigestTab() {
  const { connected, api } = useConnection()
  const [digest, setDigest] = useState(null)
  const [jobs, setJobs] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncError, setSyncError] = useState(null)
  const [runningJob, setRunningJob] = useState(null)

  const fetchDigest = useCallback(async () => {
    setError(null)
    try {
      const res = await api.getDigest()
      setDigest(res)
    } catch (err) {
      setError(err.message || 'Could not load the digest.')
    } finally {
      setLoading(false)
    }
  }, [api])

  const fetchSync = useCallback(async () => {
    try {
      const res = await api.getSync()
      setJobs(res.jobs || {})
    } catch (err) {
      setSyncError(err.message || 'Could not load sync status.')
    }
  }, [api])

  useEffect(() => {
    if (!connected) return
    setLoading(true)
    fetchDigest()
    fetchSync()
  }, [connected, fetchDigest, fetchSync])

  useEventRefresh(() => { fetchDigest(); fetchSync() }, { enabled: connected })

  async function handleRunJob(name) {
    setRunningJob(name)
    setSyncError(null)
    try {
      await api.runSync(name)
      await fetchSync()
    } catch (err) {
      setSyncError(err.message || `Could not run ${name}.`)
    } finally {
      setRunningJob(null)
    }
  }

  if (!connected) return <NotConnected />

  return (
    <div>
      <ErrorBanner message={syncError} />
      <SyncStrip jobs={jobs} onRun={handleRunJob} running={runningJob} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div className="section-header" style={{ marginBottom: 0 }}>
          Daily digest {digest?.date ? `· ${digest.date}` : ''}
        </div>
        <button
          type="button"
          className="btn"
          onClick={fetchDigest}
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 0.9rem' }}
        >
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>

      <ErrorBanner message={error} onRetry={fetchDigest} />

      {loading ? (
        <Loading label="Loading digest…" />
      ) : !digest?.markdown ? (
        <EmptyState icon={Newspaper} title="No digest yet" hint="Run a sync job above, then refresh." />
      ) : (
        <div className="card">
          <SafeMarkdown text={digest.markdown} />
        </div>
      )}
    </div>
  )
}
