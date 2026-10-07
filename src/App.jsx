import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Columns3, Folder, GitBranch, Inbox, MessagesSquare, Newspaper, Settings, Target, Zap } from 'lucide-react'
import { ConnectionProvider } from './command-center/ConnectionContext'
import SettingsTab from './command-center/SettingsTab'
import InboxTab from './command-center/InboxTab'
import MyTasksTab from './command-center/MyTasksTab'
import BoardTab from './command-center/BoardTab'
import RulesTab from './command-center/RulesTab'
import DigestTab from './command-center/DigestTab'
import GithubTab from './command-center/GithubTab'
import GoalsTab from './command-center/GoalsTab'
import ProjectsTab from './command-center/ProjectsTab'
import ThreadsTab from './command-center/ThreadsTab'
import TopBar from './TopBar'
import NavDrawer from './NavDrawer'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import OfflineBanner from './OfflineBanner'
import JobWarningsBanner from './JobWarningsBanner'
import ChatPanelMockup from './command-center/ChatPanelMockup'
import { useTheme } from './theme'
import { parseShareParams, stripShareParams } from './command-center/shareIntake'
import { subscribeNativeShares, subscribeNotificationTaps } from './command-center/nativeApp'
import { parseTaskParam, stripTaskParam } from './command-center/reminders'
import ReminderScheduler from './command-center/ReminderScheduler'

// Each view's icon is drawn by the sidebar and the drawer (src/NavItem.jsx); the phone tab bar
// has its own three (src/BottomNav.jsx).
const PRIMARY_ITEMS = [
  { id: 'mytasks', label: 'My tasks', icon: CheckCircle2 },
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'board', label: 'Board', icon: Columns3 },
]

const MORE_ITEMS = [
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'projects', label: 'Projects', icon: Folder },
  { id: 'threads', label: 'Threads', icon: MessagesSquare },
  { id: 'rules', label: 'Rules', icon: Zap },
  { id: 'digest', label: 'Digest', icon: Newspaper },
  { id: 'github', label: 'GitHub', icon: GitBranch },
]

// The last row of the navigation, with the connection status beside it.
const SETTINGS_ITEM = { id: 'settings', label: 'Settings', icon: Settings }

const DEFAULT_TAB = 'mytasks'
const ALL_TAB_IDS = new Set([...PRIMARY_ITEMS, ...MORE_ITEMS, SETTINGS_ITEM].map((item) => item.id))
// The settings page used to be called Connection, so old bookmarks to ?view=connection still land on it.
const VIEW_ALIASES = { connection: 'settings' }

// Accepted `?view=` query values: mytasks (the default; also the value the URL is cleared to),
// inbox, board, goals, projects, threads, rules, digest, github, settings (or its old name connection). Anything else is ignored and the default tab is used instead.
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
  // A share that arrived in the URL is read at startup and its parameters removed on mount, so a
  // reload does not open the sheet again. The read is in the initialiser and the strip in an
  // effect because StrictMode runs initialisers twice, both before any effect.
  const [pendingShare, setPendingShare] = useState(() => parseShareParams(window.location.search))
  useEffect(() => { stripShareParams() }, [])
  // A share at startup always lands on My tasks, whatever ?view= says.
  // A task link (?task=<id>, or a tapped reminder) opens that task's panel on My tasks, same pattern.
  const [pendingTaskId, setPendingTaskId] = useState(() => parseTaskParam(window.location.search))
  useEffect(() => { stripTaskParam() }, [])
  const [tab, setTab] = useState(() => (pendingShare || pendingTaskId ? DEFAULT_TAB : readInitialTab()))
  const consumeFocusTask = useCallback(() => setPendingTaskId(null), [])
  // Drops a share only if it is still the pending one: a newer share that arrived meanwhile stays.
  const consumeShare = useCallback((done) => setPendingShare((cur) => (cur === done ? null : cur)), [])

  // The Android shell delivers shares as a native event instead of a URL load.
  useEffect(() => subscribeNativeShares((share) => {
    setPendingShare(share)
    setTab(DEFAULT_TAB)
  }), [])
  useEffect(() => subscribeNotificationTaps((taskId) => {
    setPendingTaskId(taskId)
    setTab(DEFAULT_TAB)
  }), [])
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
    [...PRIMARY_ITEMS, ...MORE_ITEMS, SETTINGS_ITEM].find((i) => i.id === tab)?.label || ''

  return (
    <ConnectionProvider>
      <div className="app-shell">
        <Sidebar
          primaryItems={PRIMARY_ITEMS}
          moreItems={MORE_ITEMS}
          connectionItem={SETTINGS_ITEM}
          activeTab={tab}
          onSelect={setTab}
        />
        <div className="app-content">
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
        <OfflineBanner onConnect={() => setTab('settings')} />
        <ReminderScheduler />
        <JobWarningsBanner />
        <NavDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          primaryItems={PRIMARY_ITEMS}
          moreItems={MORE_ITEMS}
          connectionItem={SETTINGS_ITEM}
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
          {tab === 'mytasks' && (
            <MyTasksTab
              share={pendingShare}
              onShareConsumed={consumeShare}
              focusTaskId={pendingTaskId}
              onFocusTaskConsumed={consumeFocusTask}
            />
          )}
          {tab === 'board' && <BoardTab />}
          {tab === 'threads' && <ThreadsTab />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'digest' && <DigestTab />}
          {tab === 'github' && <GithubTab />}
          {tab === 'settings' && <SettingsTab theme={theme} onThemeChange={setTheme} />}
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
      </div>
    </ConnectionProvider>
  )
}
