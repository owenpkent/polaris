import { useEffect, useRef, useState } from 'react'
import { ConnectionProvider } from './command-center/ConnectionContext'
import SettingsForm from './command-center/SettingsForm'
import AgentSettings from './command-center/AgentSettings'
import BackupSettings from './command-center/BackupSettings'
import InboxTab from './command-center/InboxTab'
import MyTasksTab from './command-center/MyTasksTab'
import BoardTab from './command-center/BoardTab'
import RulesTab from './command-center/RulesTab'
import DigestTab from './command-center/DigestTab'
import GithubTab from './command-center/GithubTab'
import GoalsTab from './command-center/GoalsTab'
import ProjectsTab from './command-center/ProjectsTab'
import TopBar from './TopBar'
import NavDrawer from './NavDrawer'
import BottomNav from './BottomNav'
import OfflineBanner from './OfflineBanner'
import JobWarningsBanner from './JobWarningsBanner'
import ChatPanelMockup from './command-center/ChatPanelMockup'
import { useTheme } from './theme'

const PRIMARY_ITEMS = [
  { id: 'mytasks', label: 'My tasks' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'board', label: 'Board' },
]

const MORE_ITEMS = [
  { id: 'goals', label: 'Goals' },
  { id: 'projects', label: 'Projects' },
  { id: 'rules', label: 'Rules' },
  { id: 'digest', label: 'Digest' },
  { id: 'github', label: 'GitHub' },
]

const CONNECTION_ITEM = { id: 'connection', label: 'Connection' }

const DEFAULT_TAB = 'mytasks'
const ALL_TAB_IDS = new Set([...PRIMARY_ITEMS, ...MORE_ITEMS, CONNECTION_ITEM].map((item) => item.id))
// settings is accepted as an alias for connection, since that is the tab that holds the
// connection/settings form; there is no separate "settings" tab id internally.
const VIEW_ALIASES = { settings: 'connection' }

// Accepted `?view=` query values: mytasks (the default; also the value the URL is cleared to),
// inbox, board, goals, projects, rules, digest, github, connection (or its alias settings). Anything else is ignored and the default tab is used instead.
function readInitialTab() {
  try {
    const raw = new URLSearchParams(window.location.search).get('view')
    if (!raw) return DEFAULT_TAB
    const id = VIEW_ALIASES[raw] || raw
    return ALL_TAB_IDS.has(id) ? id : DEFAULT_TAB
  } catch {
    return DEFAULT_TAB
  }
}

// The Phase 3 chat panel is still a mockup with canned replies, so it only appears when the URL
// carries ?chat=mockup. `&open=1` also opens it on load, for screenshots.
function readChatMockup() {
  try {
    const params = new URLSearchParams(window.location.search)
    return { enabled: params.get('chat') === 'mockup', open: params.get('open') === '1' }
  } catch {
    return { enabled: false, open: false }
  }
}

export default function App() {
  const [tab, setTab] = useState(readInitialTab)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const menuButtonRef = useRef(null)
  // Whichever control opened the drawer (the top bar's menu button, or More in the phone's tab
  // bar) gets focus back when it closes.
  const drawerOpenerRef = useRef(null)
  const openDrawer = (opener) => {
    drawerOpenerRef.current = opener || menuButtonRef.current
    setDrawerOpen(true)
  }
  const [chatMockup] = useState(readChatMockup)
  const [chatOpen, setChatOpen] = useState(chatMockup.enabled && chatMockup.open)
  const chatButtonRef = useRef(null)
  const { theme, resolvedTheme, setTheme } = useTheme()

  // Mirror the active tab into the URL so it can be bookmarked or shared, without adding history
  // entries. Only the `view` search param is touched; the hash (used for the one-time connection
  // handoff, see ConnectionContext) and any other search params are preserved as-is.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      if (tab === DEFAULT_TAB) {
        params.delete('view')
      } else {
        params.set('view', tab)
      }
      const search = params.toString()
      const url = window.location.pathname + (search ? `?${search}` : '') + window.location.hash
      window.history.replaceState(null, '', url)
    } catch {
      // Ignore URL/history errors (e.g. sandboxed environments); the tab still works in state.
    }
  }, [tab])

  const currentTitle =
    [...PRIMARY_ITEMS, ...MORE_ITEMS, CONNECTION_ITEM].find((i) => i.id === tab)?.label || ''

  return (
    <ConnectionProvider>
      <div style={{ minHeight: '100vh' }}>
        <TopBar
          title={currentTitle}
          onMenuClick={(e) => openDrawer(e?.currentTarget)}
          menuOpen={drawerOpen}
          menuButtonRef={menuButtonRef}
          onChatClick={chatMockup.enabled ? () => setChatOpen((v) => !v) : undefined}
          chatOpen={chatOpen}
          chatButtonRef={chatButtonRef}
          theme={theme}
          resolvedTheme={resolvedTheme}
          onThemeChange={setTheme}
        />
        <OfflineBanner onConnect={() => setTab('connection')} />
        <JobWarningsBanner />
        <NavDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          primaryItems={PRIMARY_ITEMS}
          moreItems={MORE_ITEMS}
          connectionItem={CONNECTION_ITEM}
          activeTab={tab}
          onSelect={(id) => { setTab(id); setDrawerOpen(false) }}
          menuButtonRef={drawerOpenerRef}
        />

        <main
          className={chatOpen ? 'app-main-full chat-docked' : 'app-main-full'}
        >
          {tab === 'goals' && <GoalsTab />}
          {tab === 'projects' && <ProjectsTab />}
          {tab === 'inbox' && <InboxTab />}
          {tab === 'mytasks' && <MyTasksTab />}
          {tab === 'board' && <BoardTab />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'digest' && <DigestTab />}
          {tab === 'github' && <GithubTab />}
          {tab === 'connection' && (
            <div style={{ maxWidth: 480, margin: '2rem auto' }}>
              <SettingsForm />
              <AgentSettings />
              <BackupSettings />
            </div>
          )}
        </main>
        <BottomNav
          items={PRIMARY_ITEMS}
          activeTab={tab}
          onSelect={setTab}
          onMore={openDrawer}
          moreOpen={drawerOpen}
        />
        {chatMockup.enabled && (
          <ChatPanelMockup open={chatOpen} onClose={() => setChatOpen(false)} openButtonRef={chatButtonRef} />
        )}
      </div>
    </ConnectionProvider>
  )
}
