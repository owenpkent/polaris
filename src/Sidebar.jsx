import { useCallback, useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { useConnection } from './command-center/ConnectionContext'
import { useEventRefresh } from './command-center/useEvents'
import NavItem, { ConnectionStatus, InboxBadge, inboxLabel } from './NavItem'

// The desktop navigation: every view in one always-visible column on the left, so nothing sits
// behind a menu button. Shown above 640px only (.app-sidebar in index.css); under it the phone's
// tab bar (src/BottomNav.jsx) and the drawer (src/NavDrawer.jsx) take over.
export default function Sidebar({ primaryItems, moreItems, connectionItem, activeTab, onSelect }) {
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
    <aside className="app-sidebar">
      <div className="nav-brand">
        <span className="nav-brand-mark" aria-hidden="true">
          <Star size={15} strokeWidth={2.5} />
        </span>
        <span>Polaris</span>
      </div>
      <nav aria-label="Navigation" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'column', padding: '8px 0' }}>
          {primaryItems.map((item) => (
            <NavItem
              key={item.id}
              item={item}
              active={item.id === activeTab}
              onSelect={onSelect}
              trailing={item.id === 'inbox' ? <InboxBadge count={inboxCount} /> : null}
              ariaLabel={item.id === 'inbox' ? inboxLabel(item, inboxCount) : undefined}
            />
          ))}
        </div>
        <div style={{ borderTop: '1px solid var(--bd)' }} />
        <div style={{ display: 'flex', flexDirection: 'column', padding: '8px 0' }}>
          {moreItems.map((item) => (
            <NavItem key={item.id} item={item} active={item.id === activeTab} onSelect={onSelect} />
          ))}
        </div>
        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--bd)', padding: '8px 0' }}>
          <NavItem
            item={connectionItem}
            active={connectionItem.id === activeTab}
            onSelect={onSelect}
            trailing={<ConnectionStatus connected={connected} />}
          />
        </div>
      </nav>
    </aside>
  )
}
