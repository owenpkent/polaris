import { useCallback, useEffect, useMemo, useState } from 'react'
import { Star } from 'lucide-react'
import { useConnection } from './command-center/ConnectionContext'
import { useEventRefresh } from './command-center/useEvents'
import { projectColor } from './command-center/shared'
import NavItem, { ConnectionStatus, InboxBadge, inboxLabel } from './NavItem'

// The sidebar lists this many projects (the busiest first); the Projects view has the rest.
const PROJECT_LIMIT = 8

// The desktop navigation: every view in one always-visible column on the left, so nothing sits
// behind a menu button, then the open projects, each of which opens the Board on that project.
// Shown above 640px only (.app-sidebar in index.css); under it the phone's tab bar
// (src/BottomNav.jsx) and the drawer (src/NavDrawer.jsx) take over.
export default function Sidebar({ primaryItems, moreItems, connectionItem, activeTab, onSelect, boardProjectId = null, onSelectProject }) {
  const { connected, api } = useConnection()
  const [inboxCount, setInboxCount] = useState(null)
  const [projects, setProjects] = useState([])

  const refreshInbox = useCallback(async () => {
    try {
      const res = await api.listInbox()
      setInboxCount((res?.tasks || []).length)
    } catch {
      setInboxCount(null)
    }
  }, [api])

  // Guarded, since a connection without a project list (or a test's stub) just shows no projects.
  const refreshProjects = useCallback(async () => {
    if (typeof api.listProjects !== 'function') return
    try {
      const res = await api.listProjects()
      setProjects(res?.projects || [])
    } catch {
      setProjects([])
    }
  }, [api])

  const refresh = useCallback(() => {
    refreshInbox()
    refreshProjects()
  }, [refreshInbox, refreshProjects])

  useEffect(() => {
    if (!connected) return
    refresh()
  }, [connected, refresh])

  useEventRefresh(refresh, { enabled: connected })

  const listedProjects = useMemo(
    () => [...projects]
      .filter((p) => !p.archived)
      .sort((a, b) => (b.counts?.open || 0) - (a.counts?.open || 0) || a.name.localeCompare(b.name))
      .slice(0, PROJECT_LIMIT),
    [projects]
  )

  return (
    <aside className="app-sidebar">
      <div className="nav-brand">
        <span className="nav-brand-mark" aria-hidden="true">
          <Star size={15} strokeWidth={2.5} />
        </span>
        <span>Polaris</span>
      </div>
      <nav aria-label="Navigation" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 0' }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 0' }}>
          {moreItems.map((item) => (
            <NavItem key={item.id} item={item} active={item.id === activeTab} onSelect={onSelect} />
          ))}
        </div>
        {listedProjects.length > 0 && onSelectProject && (
          <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 8 }}>
            <div className="nav-group-label" aria-hidden="true">Projects</div>
            {listedProjects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="nav-item"
                aria-label={`${p.name} board`}
                aria-current={activeTab === 'board' && boardProjectId === p.id ? 'page' : undefined}
                onClick={() => onSelectProject(p.id)}
              >
                <span className="nav-project-mark" aria-hidden="true" style={{ background: projectColor(p.name) }} />
                <span className="nav-item-label">{p.name}</span>
              </button>
            ))}
          </div>
        )}
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
