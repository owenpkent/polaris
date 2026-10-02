import { useEffect } from 'react'
import { X } from 'lucide-react'
import { Kbd } from './shared'

const SHORTCUTS = [
  ['Enter', 'Open the focused task'],
  ['Esc', 'Close the open panel, dialog, or inline input'],
  ['?', 'Toggle this help'],
]

// Small modal listing the keyboard shortcuts this page has. Reuses the
// existing .modal-backdrop/.modal pair (see Projects.jsx / TaskDetailPanel.jsx
// for the same convention).
export default function KeyboardLegendDialog({ onClose }) {
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" style={{ maxWidth: 360 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div className="section-header" style={{ marginBottom: 0 }}>Keyboard shortcuts</div>
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {SHORTCUTS.map(([key, label]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
              <Kbd>{key}</Kbd>
              <span style={{ color: 'var(--t2)', fontSize: '0.875rem' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
