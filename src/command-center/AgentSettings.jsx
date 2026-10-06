import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnection } from './ConnectionContext'
import { useOffline } from './offlineStatus'
import { ErrorBanner } from './shared'
import { rememberDefaultAgentName } from './defaultAgentName'

// The owner's default agent name (command-center/src/http/rest.ts): what "Assign to AI" claims a task with,
// and the name history lines show next to "agent" (docs/assign-to-ai-options.md, stage 5B).
// Shown on the Settings tab next to Backups. Saves on blur or Enter; the PATCH is live-only
// (api.js has no `offline` kind for it), so it is off whenever the server cannot be reached.
export default function AgentSettings() {
  const { connected, api } = useConnection()
  const offline = useOffline()
  const [saved, setSaved] = useState(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // Esc reverts the draft and blurs in one go; the blur that follows must not then save the
  // value Esc just discarded, which a state update alone could not prevent in time.
  const cancelledRef = useRef(false)
  // The saved name as of the last load, so a load that lands while the owner is typing keeps
  // what they typed instead of replacing it.
  const savedRef = useRef(null)
  // Bumped by every save, so a read that started before a save cannot then undo it.
  const savesRef = useRef(0)

  const load = useCallback(async () => {
    const saves = savesRef.current
    try {
      const res = await api.getAgentSettings()
      if (savesRef.current !== saves) return
      const before = savedRef.current ?? ''
      savedRef.current = res.defaultAgentName
      setSaved(res.defaultAgentName)
      setDraft((current) => (current === before ? res.defaultAgentName : current))
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [api])

  useEffect(() => { if (connected) load() }, [connected, load])

  if (!connected) return null

  async function save() {
    const next = draft.trim()
    if (!next || next === saved) {
      setDraft(saved ?? '')
      return
    }
    savesRef.current += 1
    setBusy(true)
    setError(null)
    try {
      const res = await api.updateAgentSettings({ defaultAgentName: next })
      savedRef.current = res.defaultAgentName
      setSaved(res.defaultAgentName)
      setDraft(res.defaultAgentName)
      // An open task panel offers "Assign to <name>": tell it, since no event announces this.
      rememberDefaultAgentName(res.defaultAgentName)
    } catch (err) {
      setError(err.message || 'Could not save the agent name.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card" aria-labelledby="cc-agents-heading">
      <div className="section-header" id="cc-agents-heading">Agents</div>

      <div className="field" style={{ marginBottom: error ? '0.75rem' : 0 }}>
        <label htmlFor="cc-default-agent-name">Default agent name</label>
        <input
          id="cc-default-agent-name"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (cancelledRef.current) {
              cancelledRef.current = false
              return
            }
            save()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              // Consistent with the neighbouring Backups form: Esc discards what was typed
              // rather than saving it.
              cancelledRef.current = true
              setDraft(saved ?? '')
              e.currentTarget.blur()
            }
          }}
          disabled={offline || busy}
          autoComplete="off"
        />
      </div>

      {error && <ErrorBanner message={error} />}
    </section>
  )
}
