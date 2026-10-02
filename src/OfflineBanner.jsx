import { useState } from 'react'
import { AlertCircle, CheckCircle2, HardDrive, WifiOff, X } from 'lucide-react'
import { useConnection } from './command-center/ConnectionContext'
import { STALE_AFTER_MS, setLastSync, useOfflineStatus } from './command-center/offlineStatus'
import { discardOutbox, flushOutbox } from './command-center/outbox'
import { useMirrorWarm } from './command-center/useMirrorWarm'

function formatWhen(at, now) {
  const date = new Date(at)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return time
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

const FIELD_LABELS = {
  title: 'name', notes: 'notes', dueAt: 'due date', priority: 'priority', status: 'status',
  projectId: 'project', sectionId: 'section', parentId: 'parent', startAt: 'start date', recurrence: 'recurrence',
}

export function Strip({ tone, soft, icon: Icon, children, actions }) {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px 10px',
        minHeight: 44,
        padding: '8px 16px',
        background: soft,
        borderBottom: `1px solid ${tone}`,
        color: 'var(--t1)',
        fontSize: 14,
      }}
    >
      <Icon size={18} aria-hidden="true" style={{ color: tone, flexShrink: 0 }} />
      <span style={{ flex: '1 1 240px', minWidth: 0 }}>{children}</span>
      {actions}
    </div>
  )
}

// Shown under the top bar. While the server cannot be reached every tab reads the local copy
// (offlineCache.js), task edits are queued (outbox.js), and every other control that writes is
// disabled. When the server is back it reports what happened to the queued edits. It also owns
// useMirrorWarm, since it is the one component that is always mounted inside the connection.
// In local mode (no connection yet) it says where new tasks are kept and offers the way to connect.
export default function OfflineBanner({ now = Date.now(), onConnect }) {
  const { connected, local, baseUrl, token } = useConnection()
  const { offline, lastOnlineAt, pending, lastSync } = useOfflineStatus()
  const [busy, setBusy] = useState(false)
  useMirrorWarm()

  if (local) {
    return (
      <Strip
        tone="var(--blue)"
        soft="var(--blue-soft)"
        icon={HardDrive}
        actions={onConnect ? <button type="button" className="btn" onClick={onConnect}>Connect</button> : null}
      >
        <strong style={{ color: 'var(--blue)' }}>Not connected yet.</strong> Tasks you add are kept on this device and
        sent to the server the first time you connect.
        {pending > 0 ? ` ${plural(pending, 'change', 'changes')} waiting.` : ''}
      </Strip>
    )
  }

  if (!connected) return null

  if (offline) {
    const stale = lastOnlineAt !== null && now - lastOnlineAt > STALE_AFTER_MS
    const tone = stale ? 'var(--red)' : 'var(--yellow)'
    const showing = lastOnlineAt === null
      ? 'Showing the copy saved on this device.'
      : `Showing data from ${formatWhen(lastOnlineAt, now)}.`
    return (
      <Strip tone={tone} soft={stale ? 'var(--red-soft)' : 'var(--yellow-soft)'} icon={WifiOff}>
        <strong style={{ color: tone }}>Offline.</strong> {showing}
        {stale ? ' That is more than a day old.' : ''} Task changes are saved on this device and sent when the
        server is back. Everything else is off.
        {pending > 0 ? ` ${plural(pending, 'change', 'changes')} waiting.` : ''}
      </Strip>
    )
  }

  if (!lastSync) return null

  if (lastSync.failed) {
    const retry = async () => {
      setBusy(true)
      setLastSync(null)
      await flushOutbox(baseUrl, token)
      setBusy(false)
    }
    return (
      <Strip
        tone="var(--red)"
        soft="var(--red-soft)"
        icon={AlertCircle}
        actions={(
          <>
            <button type="button" className="btn" disabled={busy} onClick={retry}>Try again</button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => discardOutbox(baseUrl)}>Discard them</button>
          </>
        )}
      >
        <strong style={{ color: 'var(--red)' }}>Not sent.</strong>{' '}
        The server refused {plural(lastSync.count, 'offline change', 'offline changes')} (error {lastSync.status}).
        They are still saved on this device.
      </Strip>
    )
  }

  const { synced, conflicts = [], rejected = [] } = lastSync
  const clean = conflicts.length === 0 && rejected.length === 0
  const tone = clean ? 'var(--green)' : 'var(--yellow)'
  return (
    <Strip
      tone={tone}
      soft={clean ? 'var(--green-soft)' : 'var(--yellow-soft)'}
      icon={clean ? CheckCircle2 : AlertCircle}
      actions={(
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setLastSync(null)}>
          <X size={18} aria-hidden="true" />
        </button>
      )}
    >
      <strong style={{ color: tone }}>Back online.</strong> {plural(synced, 'offline change', 'offline changes')} sent
      {conflicts.length > 0 ? `, ${plural(conflicts.length, 'conflict', 'conflicts')}` : ''}
      {rejected.length > 0 ? `, ${rejected.length} refused` : ''}.
      {conflicts.map((c) => (
        <span key={`${c.taskId}-${c.fields.join('-')}`} style={{ display: 'block', color: 'var(--t2)' }}>
          {c.title || 'A task'}: a newer edit was kept for {c.fields.map((f) => FIELD_LABELS[f] || f).join(', ')}.
          The other value is in the task history.
        </span>
      ))}
    </Strip>
  )
}
