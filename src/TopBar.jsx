import { useRef, useState } from 'react'
import { Menu as MenuIcon, MessageSquare, Monitor, Moon, Sun } from 'lucide-react'
import { Menu } from './command-center/Menu'

// The theme control is a menu rather than a two-state toggle so "System" stays
// reachable: a toggle can only ever leave the choice pinned to one theme.
const THEME_LABELS = [
  ['system', 'System', Monitor],
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
]

export default function TopBar({
  title,
  onMenuClick,
  menuOpen,
  menuButtonRef,
  onChatClick,
  chatOpen,
  chatButtonRef,
  theme = 'system',
  resolvedTheme = 'dark',
  onThemeChange,
}) {
  const themeButtonRef = useRef(null)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  // The icon shows what is on screen now, not which choice is stored, so
  // "System" still reads as light or dark at a glance.
  const ThemeIcon = resolvedTheme === 'light' ? Sun : Moon

  const themeItems = THEME_LABELS.map(([id, label, Icon]) => ({
    key: id,
    label,
    icon: <Icon size={16} aria-hidden="true" />,
    checked: theme === id,
    radio: true, // one choice, not three independent toggles
    onSelect: () => onThemeChange?.(id),
  }))

  return (
    <header
      style={{
        height: 56,
        minHeight: 56,
        background: 'var(--bg2)',
        borderBottom: '1px solid var(--bd-surface)',
        boxShadow: 'var(--shadow-bar)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        padding: '0 1rem',
        gap: '0.75rem',
      }}
    >
      <button
        ref={menuButtonRef}
        type="button"
        aria-label="Open navigation"
        aria-expanded={menuOpen}
        onClick={onMenuClick}
        className="icon-btn"
        style={{ color: 'var(--t1)' }}
      >
        <MenuIcon size={22} aria-hidden="true" />
      </button>
      <h1
        style={{
          fontSize: '1.25rem',
          fontWeight: 600,
          color: 'var(--t1)',
          margin: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginLeft: 'auto' }}>
        <button
          ref={themeButtonRef}
          type="button"
          aria-label="Theme"
          aria-haspopup="menu"
          aria-expanded={themeMenuOpen}
          onClick={() => setThemeMenuOpen((open) => !open)}
          className="icon-btn"
          style={{ color: 'var(--t1)' }}
        >
          <ThemeIcon size={20} aria-hidden="true" />
        </button>
        <Menu
          anchorRef={themeButtonRef}
          open={themeMenuOpen}
          onClose={() => setThemeMenuOpen(false)}
          items={themeItems}
          align="end"
          minWidth={180}
          label="Theme"
        />
        {onChatClick && (
          <button
            ref={chatButtonRef}
            type="button"
            aria-label="Ask Polaris"
            aria-expanded={chatOpen}
            onClick={onChatClick}
            className="icon-btn"
            style={{ color: 'var(--t1)' }}
          >
            <MessageSquare size={22} aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  )
}
