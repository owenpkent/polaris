import { useState, useEffect } from 'react'
import { Inbox, AlertCircle } from 'lucide-react'

export const PRIORITY_COLORS = {
  none: 'var(--t2)',
  low: 'var(--blue)',
  medium: 'var(--yellow)',
  high: 'var(--orange)',
  urgent: 'var(--red)',
}

export const STATUS_LABELS = {
  inbox: 'Inbox',
  open: 'Open',
  in_progress: 'In progress',
  waiting: 'Waiting',
  done: 'Done',
  dropped: 'Dropped',
}

export function formatDate(value) {
  if (!value) return ''
  // A plain date (a due date) is a day on the owner's calendar. new Date() would read it as UTC
  // midnight, which is the day before anywhere west of UTC.
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const d = plain ? new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3])) : new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function todayIso() {
  return new Date().toISOString().split('T')[0]
}

export function isOverdue(task) {
  if (!task?.dueAt || task.status === 'done' || task.status === 'dropped') return false
  return task.dueAt.slice(0, 10) < todayIso()
}

export function PriorityChip({ priority }) {
  if (!priority || priority === 'none') return null
  const color = PRIORITY_COLORS[priority] || 'var(--t2)'
  return (
    <span
      className="badge"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color, textTransform: 'capitalize' }}
    >
      {priority}
    </span>
  )
}

export function StatusChip({ status }) {
  const label = STATUS_LABELS[status] || status
  return (
    <span className="badge" style={{ background: 'var(--neutral-soft)', color: 'var(--t2)' }}>
      {label}
    </span>
  )
}

export function SourceBadge({ sourceType }) {
  return (
    <span className="badge" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>
      {sourceType || 'manual'}
    </span>
  )
}

export function Kbd({ children }) {
  return (
    <kbd
      style={{
        background: 'var(--bg2)',
        border: '1px solid var(--bd-strong)',
        borderRadius: 4,
        padding: '0.05rem 0.4rem',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.78rem',
      }}
    >
      {children}
    </kbd>
  )
}

export function KeyboardLegend({ items }) {
  return (
    <div
      className="card"
      style={{
        display: 'flex',
        gap: '1.25rem',
        flexWrap: 'wrap',
        fontSize: '0.8rem',
        color: 'var(--t2)',
        alignItems: 'center',
        padding: '0.65rem 1rem',
        marginBottom: '1.25rem',
      }}
    >
      <span style={{ fontWeight: 600, color: 'var(--t1)' }}>Keyboard:</span>
      {items.map(([key, label]) => (
        <span key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Kbd>{key}</Kbd> {label}
        </span>
      ))}
    </div>
  )
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '2.5rem 1rem',
        color: 'var(--t2)',
        fontSize: '0.875rem',
        border: '1px dashed var(--bd)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {label}
    </div>
  )
}

export function EmptyState({ icon: Icon = Inbox, title, hint }) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '2.5rem 1rem',
        border: '1px dashed var(--bd)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <Icon size={28} aria-hidden="true" style={{ color: 'var(--t3)', margin: '0 auto 0.75rem' }} />
      <div style={{ fontWeight: 500, marginBottom: '0.4rem', color: 'var(--t1)', fontSize: '0.875rem' }}>{title}</div>
      {hint && <div style={{ fontSize: '0.8125rem', color: 'var(--t3)' }}>{hint}</div>}
    </div>
  )
}

export function ErrorBanner({ message, onRetry }) {
  if (!message) return null
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.75rem 1rem',
        marginBottom: '1.25rem',
        background: 'var(--red-soft)',
        borderLeft: '3px solid var(--red)',
        borderRadius: 'var(--radius)',
      }}
    >
      <AlertCircle size={18} aria-hidden="true" style={{ color: 'var(--red)', flexShrink: 0 }} />
      <span style={{ flexGrow: 1, color: 'var(--t1)', fontSize: '0.875rem' }}>{message}</span>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry} style={{ flexShrink: 0 }}>
          Retry
        </button>
      )}
    </div>
  )
}

// A destructive action that requires a second, explicit click within a short
// window rather than a native confirm() dialog or a hover-revealed control.
export function ConfirmButton({ label, confirmLabel = 'Confirm', onConfirm, style, className = 'btn', disabled = false }) {
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return undefined
    const t = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(t)
  }, [confirming])

  if (confirming) {
    return (
      <span style={{ display: 'inline-flex', gap: '0.5rem' }}>
        <button
          type="button"
          className={className}
          disabled={disabled}
          style={{ ...style, borderColor: 'var(--red)', color: 'var(--red)' }}
          onClick={() => {
            setConfirming(false)
            onConfirm()
          }}
        >
          {confirmLabel}?
        </button>
        <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </span>
    )
  }

  return (
    <button type="button" className={className} style={style} disabled={disabled} onClick={() => setConfirming(true)}>
      {label}
    </button>
  )
}
