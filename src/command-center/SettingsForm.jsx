import { useState } from 'react'
import { useConnection } from './ConnectionContext'
import { DEFAULT_BASE_URL } from './api'
import { useOfflineStatus } from './offlineStatus'
import { ConfirmButton } from './shared'

export default function SettingsForm() {
  const { baseUrl, token, connected, health, testing, testResult, saveSettings, disconnect } = useConnection()
  // Edits made offline and not yet sent. Disconnect drops them along with the local copy.
  const { pending } = useOfflineStatus()
  const [formBaseUrl, setFormBaseUrl] = useState(baseUrl)
  const [formToken, setFormToken] = useState(token)
  const [showToken, setShowToken] = useState(false)

  function handleSubmit(e) {
    e.preventDefault()
    saveSettings(formBaseUrl.trim(), formToken.trim())
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <div className="section-header">Connection settings</div>

      <div className="field">
        <label htmlFor="cc-base-url">Server URL</label>
        <input
          id="cc-base-url"
          type="text"
          value={formBaseUrl}
          onChange={(e) => setFormBaseUrl(e.target.value)}
          placeholder={DEFAULT_BASE_URL || 'https://your-server'}
        />
      </div>

      <div className="field">
        <label htmlFor="cc-token">Access token</label>
        <input
          id="cc-token"
          type={showToken ? 'text' : 'password'}
          value={formToken}
          onChange={(e) => setFormToken(e.target.value)}
          placeholder="Paste the token printed by serve --show-token"
          autoComplete="off"
        />
      </div>

      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.8rem',
          color: 'var(--t2)',
          marginBottom: '1rem',
          cursor: 'pointer',
          minHeight: 44,
          padding: '0 4px',
          borderRadius: 'var(--radius)',
        }}
      >
        <input
          type="checkbox"
          checked={showToken}
          onChange={(e) => setShowToken(e.target.checked)}
          style={{ width: 18, height: 18 }}
        />
        Show token
      </label>

      {testResult && (
        <div
          role="status"
          style={{
            padding: '0.6rem 0.85rem',
            borderRadius: 8,
            fontSize: '0.85rem',
            marginBottom: '1rem',
            background: testResult.ok ? 'var(--green-soft)' : 'var(--red-soft)',
            color: testResult.ok ? 'var(--green)' : 'var(--red)',
          }}
        >
          {testResult.message}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={testing}
          style={{ padding: '0.6rem 1.2rem', fontSize: '0.9rem' }}
        >
          {testing ? (connected ? 'Testing…' : 'Connecting…') : (connected ? 'Test connection & save' : 'Connect')}
        </button>
        {connected && pending === 0 && (
          <button
            type="button"
            className="btn"
            onClick={disconnect}
            style={{ padding: '0.6rem 1.2rem', fontSize: '0.9rem' }}
          >
            Disconnect
          </button>
        )}
        {connected && pending > 0 && (
          <ConfirmButton
            label="Disconnect"
            confirmLabel={`Discard ${pending} unsent ${pending === 1 ? 'change' : 'changes'}`}
            onConfirm={disconnect}
            style={{ padding: '0.6rem 1.2rem', fontSize: '0.9rem' }}
          />
        )}
      </div>

      {connected && pending > 0 && (
        <p role="note" style={{ fontSize: '0.85rem', color: 'var(--yellow)', marginTop: '0.75rem' }}>
          {pending} offline {pending === 1 ? 'change has' : 'changes have'} not reached the server yet. Disconnecting
          discards {pending === 1 ? 'it' : 'them'}.
        </p>
      )}

      {connected && health && (
        <div style={{ fontSize: '0.78rem', color: 'var(--t2)', marginTop: '0.85rem' }}>
          {health.counts?.inbox ?? 0} inbox · {health.counts?.overdue ?? 0} overdue · {health.counts?.today ?? 0} due today
        </div>
      )}
    </form>
  )
}
