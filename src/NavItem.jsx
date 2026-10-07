// One view in the navigation: a 44px row with the view's icon and label, marked aria-current when
// it is the open view. Shared by the desktop sidebar (src/Sidebar.jsx) and the phone drawer
// (src/NavDrawer.jsx). The look lives in .nav-item (index.css).
export default function NavItem({ item, active, onSelect, indent = false, trailing = null, ariaLabel }) {
  const Icon = item.icon
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(item.id)}
      className={indent ? 'nav-item is-indented' : 'nav-item'}
    >
      {Icon && (
        <span className="nav-item-icon">
          <Icon size={18} aria-hidden="true" />
        </span>
      )}
      <span className="nav-item-label">{item.label}</span>
      {trailing}
    </button>
  )
}

// The badge is hidden from screen readers; inboxLabel gives the row its spoken name instead, so it
// reads "Inbox, 2 waiting", as the phone tab bar does, rather than "Inbox2".
export function inboxLabel(item, count) {
  return typeof count === 'number' && count > 0 ? `${item.label}, ${count} waiting` : undefined
}

export function InboxBadge({ count }) {
  if (typeof count !== 'number' || count <= 0) return null
  return (
    <span aria-hidden="true" className="badge" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>
      {count}
    </span>
  )
}

export function ConnectionStatus({ connected }) {
  return (
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
  )
}
