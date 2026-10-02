import { useState, useEffect, useCallback } from 'react'
import { Settings2 } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { useOffline } from './offlineStatus'
import NotConnected from './NotConnected'
import { Loading, EmptyState, ErrorBanner, ConfirmButton, formatDate } from './shared'

const EXAMPLE_DEFINITION = {
  trigger: { type: 'schedule', condition: 'overdue' },
  conditions: [{ field: 'priority', op: 'eq', value: 'high' }],
  actions: [{ type: 'notify', message: 'Overdue and high priority: {title}' }],
}

function RunReport({ report }) {
  if (!report) return null
  return (
    <div style={{ marginTop: '0.85rem', background: 'var(--bg2)', borderRadius: 8, padding: '0.75rem 1rem', fontSize: '0.82rem' }}>
      <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
        {report.dryRun ? 'Dry run result' : 'Run result'} · {report.fired?.length || 0} fired
      </div>
      {(report.fired || []).map((f, i) => (
        <div key={i} style={{ padding: '0.3rem 0', borderBottom: '1px solid var(--bd)' }}>
          Task {f.taskId}: {(f.actions || []).join('; ') || 'no actions'}
        </div>
      ))}
      {(report.errors || []).length > 0 && (
        <div style={{ marginTop: '0.5rem', color: 'var(--red)' }}>
          {report.errors.map((e, i) => (
            <div key={i}>{typeof e === 'string' ? e : e.message || JSON.stringify(e)}</div>
          ))}
        </div>
      )}
      {(report.fired || []).length === 0 && (report.errors || []).length === 0 && (
        <div style={{ color: 'var(--t2)' }}>Nothing matched.</div>
      )}
    </div>
  )
}

function RuleCard({ rule, onToggle, onDelete, onRunDry }) {
  const offline = useOffline()
  const [report, setReport] = useState(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)

  async function handleRunDry() {
    setRunning(true)
    setError(null)
    setReport(null)
    try {
      const res = await onRunDry(rule.id)
      setReport(res)
    } catch (err) {
      setError(err.message || 'Could not run this rule.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px' }}>
          <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: '0.3rem' }}>{rule.name}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--t2)' }}>Created {formatDate(rule.createdAt)}</div>
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.85rem',
              cursor: 'pointer',
              minHeight: 44,
              padding: '0 10px',
              marginLeft: -10,
              borderRadius: 'var(--radius)',
            }}
          >
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => onToggle(rule.id, e.target.checked)}
              disabled={offline}
              style={{ width: 22, height: 22, cursor: 'pointer' }}
            />
            Enabled
          </label>
          <button type="button" className="btn" onClick={handleRunDry} disabled={running || offline} style={{ padding: '0.5rem 0.9rem' }}>
            {running ? 'Running…' : 'Run dry'}
          </button>
          <ConfirmButton label="Delete" confirmLabel="Delete rule" onConfirm={() => onDelete(rule.id)} disabled={offline} style={{ padding: '0.5rem 0.9rem' }} />
        </div>
      </div>

      <details style={{ marginTop: '0.75rem' }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--t2)', minHeight: 44, boxSizing: 'border-box', padding: '12px 0' }}>View definition</summary>
        <pre style={{ background: 'var(--bg2)', borderRadius: 8, padding: '0.75rem', fontSize: '0.78rem', overflowX: 'auto', marginTop: '0.5rem' }}>
          {JSON.stringify(rule.definition, null, 2)}
        </pre>
      </details>

      {error && <div style={{ color: 'var(--red)', fontSize: '0.82rem', marginTop: '0.5rem' }}>{error}</div>}
      <RunReport report={report} />
    </div>
  )
}

function NewRuleForm({ onCreate }) {
  const offline = useOffline()
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [json, setJson] = useState(JSON.stringify(EXAMPLE_DEFINITION, null, 2))
  const [jsonError, setJsonError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setJsonError(null)
    setError(null)
    if (!name.trim()) {
      setError('Give the rule a name.')
      return
    }
    let definition
    try {
      definition = JSON.parse(json)
    } catch (err) {
      setJsonError(`Definition is not valid JSON: ${err.message}`)
      return
    }
    setBusy(true)
    try {
      await onCreate({ name: name.trim(), enabled, definition })
      setName('')
      setJson(JSON.stringify(EXAMPLE_DEFINITION, null, 2))
      setEnabled(true)
    } catch (err) {
      setError(err.message || 'Could not create this rule.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit} style={{ marginBottom: '1.5rem' }}>
      <div className="section-header">New rule</div>
      <div className="field">
        <label htmlFor="rule-name">Name</label>
        <input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nudge overdue high priority" />
      </div>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.85rem',
          marginBottom: '1rem',
          cursor: 'pointer',
          minHeight: 44,
          padding: '0 10px',
          marginLeft: -10,
          borderRadius: 'var(--radius)',
        }}
      >
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 20, height: 20, cursor: 'pointer' }} />
        Enabled
      </label>
      <div className="field">
        <label htmlFor="rule-json">Definition (JSON)</label>
        <textarea
          id="rule-json"
          rows={10}
          value={json}
          onChange={(e) => setJson(e.target.value)}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.82rem' }}
        />
      </div>
      {jsonError && <div style={{ color: 'var(--red)', fontSize: '0.82rem', marginBottom: '0.75rem' }}>{jsonError}</div>}
      {error && <div style={{ color: 'var(--red)', fontSize: '0.82rem', marginBottom: '0.75rem' }}>{error}</div>}
      <button type="submit" className="btn btn-primary" disabled={busy || offline} style={{ padding: '0.6rem 1.2rem' }}>
        {busy ? 'Creating…' : 'Create rule'}
      </button>
    </form>
  )
}

export default function RulesTab() {
  const { connected, api } = useConnection()
  const [rules, setRules] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchRules = useCallback(async () => {
    setError(null)
    try {
      const res = await api.listRules()
      setRules(res.rules || [])
    } catch (err) {
      setError(err.message || 'Could not load rules.')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (!connected) return
    setLoading(true)
    fetchRules()
  }, [connected, fetchRules])

  useEventRefresh(fetchRules, { enabled: connected })

  const handleToggle = useCallback(async (id, enabled) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)))
    try {
      await api.updateRule(id, { enabled })
    } catch (err) {
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !enabled } : r)))
      setError(err.message || 'Could not update that rule.')
    }
  }, [api])

  const handleDelete = useCallback(async (id) => {
    const prev = rules
    setRules((r) => r.filter((rule) => rule.id !== id))
    try {
      await api.deleteRule(id)
    } catch (err) {
      setRules(prev)
      setError(err.message || 'Could not delete that rule.')
    }
  }, [api, rules])

  const handleRunDry = useCallback((id) => api.runRules({ ruleId: id, dryRun: true }), [api])

  const handleCreate = useCallback(async (payload) => {
    await api.createRule(payload)
    await fetchRules()
  }, [api, fetchRules])

  if (!connected) return <NotConnected />

  return (
    <div>
      <NewRuleForm onCreate={handleCreate} />
      <ErrorBanner message={error} onRetry={fetchRules} />

      {loading ? (
        <Loading label="Loading rules…" />
      ) : rules.length === 0 ? (
        <EmptyState icon={Settings2} title="No rules yet" hint="Create one above to automate triage." />
      ) : (
        rules.map((rule) => (
          <RuleCard key={rule.id} rule={rule} onToggle={handleToggle} onDelete={handleDelete} onRunDry={handleRunDry} />
        ))
      )}
    </div>
  )
}
