import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Inbox, Columns3, MoreHorizontal } from 'lucide-react'
import { useConnection } from './command-center/ConnectionContext'
import { useEventRefresh } from './command-center/useEvents'

const ICONS = { mytasks: CheckCircle2, inbox: Inbox, board: Columns3 }

// The phone's tab bar: the three primary views and More, which opens the same drawer as the top
// bar's menu button. Shown only under 640px (see .bottom-nav in index.css); on desktop the sidebar
// (src/Sidebar.jsx) is the navigation. Every item is a 44px-plus target with a visible focus ring.
export default function BottomNav({ items, activeTab, onSelect, onMore, moreOpen }) {
  const { connected, api } = useConnection()
  const [inboxCount, setInboxCount] = useState(null)

  const refreshInbox = useCallback(async () => {
    try {
      const res = await api.listInbox()
      setInboxCount((res?.tasks || []).length)
    } catch {
      setInboxCount(null)
    }
  }, [api])

  useEffect(() => {
    if (!connected) return
    refreshInbox()
  }, [connected, refreshInbox])

  useEventRefresh(refreshInbox, { enabled: connected })

  return (
    <nav className="bottom-nav" aria-label="Primary">
      {items.map((item) => {
        const Icon = ICONS[item.id] || CheckCircle2
        const active = item.id === activeTab
        const showCount = item.id === 'inbox' && typeof inboxCount === 'number' && inboxCount > 0
        return (
          <button
            key={item.id}
            type="button"
            className={`bottom-nav-item${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            aria-label={showCount ? `${item.label}, ${inboxCount} waiting` : item.label}
            onClick={() => onSelect(item.id)}
          >
            <span className="bottom-nav-icon">
              <Icon size={22} aria-hidden="true" />
              {showCount && <span className="bottom-nav-count" aria-hidden="true">{inboxCount > 99 ? '99+' : inboxCount}</span>}
            </span>
            <span>{item.label}</span>
          </button>
        )
      })}
      <button
        type="button"
        className="bottom-nav-item"
        aria-label="More views"
        aria-expanded={moreOpen}
        onClick={(e) => onMore(e.currentTarget)}
      >
        <span className="bottom-nav-icon">
          <MoreHorizontal size={22} aria-hidden="true" />
        </span>
        <span>More</span>
      </button>
    </nav>
  )
}
