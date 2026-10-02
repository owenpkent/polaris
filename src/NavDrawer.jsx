import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { useConnection } from './command-center/ConnectionContext'

const MORE_EXPANDED_KEY = 'cc-nav-more-v1'

function loadExpanded() {
  try {
    const raw = localStorage.getItem(MORE_EXPANDED_KEY)
    if (raw === null) return false
    return JSON.parse(raw) === true
  } catch {
    return false
  }
}

function persistExpanded(value) {
  try {
    localStorage.setItem(MORE_EXPANDED_KEY, JSON.stringify(Boolean(value)))
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
}

export default function NavDrawer({
  open,
  onClose,
  primaryItems,
  moreItems,
  connectionItem,
  activeTab,
  onSelect,
  menuButtonRef,
}) {
  const containerRef = useRef(null)
  const prevOpenRef = useRef(open)
  const [storedExpanded, setStoredExpanded] = useState(loadExpanded)
  const [hoveredId, setHoveredId] = useState(null)
  const [closeHovered, setCloseHovered] = useState(false)
  const [inboxCount, setInboxCount] = useState(null)
  const { connected, api } = useConnection()

  const activeInMore = moreItems.some((i) => i.id === activeTab)
  const expanded = storedExpanded || activeInMore

  // Esc-to-close and a simple Tab/Shift+Tab focus trap while open.
  useEffect(() => {
    if (!open) return undefined

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = containerRef.current
        ? Array.from(containerRef.current.querySelectorAll('button'))
        : []
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !containerRef.current.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !containerRef.current.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  // Move focus into the drawer when it opens.
  useEffect(() => {
    if (open) {
      containerRef.current?.querySelector('button')?.focus()
    }
  }, [open])

  // Return focus to the menu button when the drawer closes.
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      menuButtonRef?.current?.focus()
    }
    prevOpenRef.current = open
  }, [open, menuButtonRef])

  // Refresh the inbox count each time the drawer opens.
  useEffect(() => {
    if (!open || !connected) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.listInbox()
        if (!cancelled) setInboxCount((res?.tasks || []).length)
      } catch {
        if (!cancelled) setInboxCount(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, connected, api])

  if (!open) return null

  const renderItem = (item, { indent = false, trailing = null } = {}) => {
    const isActive = item.id === activeTab
    const isHovered = hoveredId === item.id
    return (
      <button
        key={item.id}
        type="button"
        aria-current={isActive ? 'page' : undefined}
        onClick={() => onSelect(item.id)}
        onMouseEnter={() => setHoveredId(item.id)}
        onMouseLeave={() => setHoveredId((h) => (h === item.id ? null : h))}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          minHeight: 44,
          padding: indent ? '0 20px 0 36px' : '0 20px',
          background: isActive || isHovered ? 'var(--bg3)' : 'transparent',
          border: 'none',
          borderLeft: isActive ? '3px solid var(--blue)' : '3px solid transparent',
          color: isActive ? 'var(--t1)' : 'var(--t2)',
          fontWeight: isActive ? 600 : 400,
          fontSize: 15,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span>{item.label}</span>
        {trailing}
      </button>
    )
  }

  const moreHovered = hoveredId === '__more__'

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--overlay)',
          zIndex: 300,
        }}
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: 280,
          background: 'var(--bg2)',
          borderRight: '1px solid var(--bd)',
          boxShadow: 'var(--shadow-pop)',
          overflowY: 'auto',
          zIndex: 301,
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100%',
        }}
      >
        <div
          style={{
            height: 56,
            minHeight: 56,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 8px 0 20px',
            borderBottom: '1px solid var(--bd)',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--t2)' }}>Polaris</span>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
            onMouseEnter={() => setCloseHovered(true)}
            onMouseLeave={() => setCloseHovered(false)}
            style={{
              width: 44,
              height: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: closeHovered ? 'var(--bg3)' : 'transparent',
              border: 'none',
              borderRadius: 8,
              color: 'var(--t1)',
              flexShrink: 0,
            }}
          >
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', padding: '8px 0' }}>
          {primaryItems.map((item) =>
            renderItem(item, {
              trailing:
                item.id === 'inbox' && typeof inboxCount === 'number' && inboxCount > 0 ? (
                  <span className="badge" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>
                    {inboxCount}
                  </span>
                ) : null,
            })
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--bd)', margin: '0 0 8px' }} />

        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            const next = !storedExpanded
            setStoredExpanded(next)
            persistExpanded(next)
          }}
          onMouseEnter={() => setHoveredId('__more__')}
          onMouseLeave={() => setHoveredId((h) => (h === '__more__' ? null : h))}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            minHeight: 44,
            padding: '0 20px',
            background: moreHovered ? 'var(--bg3)' : 'transparent',
            border: 'none',
            color: 'var(--t2)',
            fontSize: 15,
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <span>More</span>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        {expanded && moreItems.map((item) => renderItem(item, { indent: true }))}

        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--bd)', padding: '8px 0' }}>
          {renderItem(connectionItem, {
            trailing: (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t2)' }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: connected ? 'var(--green)' : 'var(--t2)',
                    flexShrink: 0,
                  }}
                />
                {connected ? 'Connected' : 'Not connected'}
              </span>
            ),
          })}
        </div>
      </div>
    </>
  )
}
