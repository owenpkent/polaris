import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import App from './App'

vi.mock('./command-center/ConnectionContext', () => ({
  ConnectionProvider: ({ children }) => <div data-testid="connection-provider">{children}</div>,
}))

vi.mock('./command-center/GoalsTab', () => ({ default: () => <div data-testid="tab-goals" /> }))
vi.mock('./command-center/ProjectsTab', () => ({ default: () => <div data-testid="tab-projects" /> }))
vi.mock('./command-center/SettingsTab', () => ({ default: () => <div data-testid="tab-settings" /> }))
vi.mock('./command-center/InboxTab', () => ({ default: () => <div data-testid="tab-inbox" /> }))
vi.mock('./command-center/MyTasksTab', () => ({ default: () => <div data-testid="tab-mytasks" /> }))
vi.mock('./command-center/BoardTab', () => ({ default: () => <div data-testid="tab-board" /> }))
vi.mock('./command-center/RulesTab', () => ({ default: () => <div data-testid="tab-rules" /> }))
vi.mock('./command-center/DigestTab', () => ({ default: () => <div data-testid="tab-digest" /> }))
vi.mock('./command-center/GithubTab', () => ({ default: () => <div data-testid="tab-github" /> }))
vi.mock('./OfflineBanner', () => ({ default: () => <div data-testid="offline-banner" /> }))
vi.mock('./JobWarningsBanner', () => ({ default: () => null }))
vi.mock('./NavDrawer', () => ({ default: () => <div data-testid="nav-drawer" /> }))
vi.mock('./BottomNav', () => ({ default: () => <div data-testid="bottom-nav" /> }))
vi.mock('./Sidebar', () => ({ default: () => <div data-testid="sidebar" /> }))

const ALL_TAB_TESTIDS = [
  'tab-goals',
  'tab-projects',
  'tab-settings',
  'tab-inbox',
  'tab-mytasks',
  'tab-board',
  'tab-rules',
  'tab-digest',
  'tab-github',
]

function setLocation(search = '', hash = '') {
  const query = search ? `?${search}` : ''
  window.history.replaceState(null, '', '/' + query + hash)
}

afterEach(() => {
  cleanup()
  setLocation('')
})

describe('App default tab', () => {
  test('renders MyTasksTab by default when no view param is present', () => {
    setLocation('')
    const { container } = render(<App />)
    expect(container.querySelector('[data-testid="tab-mytasks"]')).not.toBeNull()
    ALL_TAB_TESTIDS.filter((id) => id !== 'tab-mytasks').forEach((id) => {
      expect(container.querySelector(`[data-testid="${id}"]`)).toBeNull()
    })
  })
})

describe('App share intake', () => {
  test('a share starts on My tasks despite ?view= and its parameters are stripped', () => {
    setLocation('view=board&share-text=Hello&share-url=https%3A%2F%2Fa.test&x=1', '#h')
    const { container } = render(<App />)
    expect(container.querySelector('[data-testid="tab-mytasks"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tab-board"]')).toBeNull()
    // The tab mirror then clears ?view= for the default tab; other params and the hash stay.
    expect(window.location.search).toBe('?x=1')
    expect(window.location.hash).toBe('#h')
  })

  test('a task link starts on My tasks despite ?view= and ?task= is stripped', () => {
    setLocation('view=board&task=t_abc123def4&x=1', '#h')
    const { container } = render(<App />)
    expect(container.querySelector('[data-testid="tab-mytasks"]')).not.toBeNull()
    expect(window.location.search).toBe('?x=1')
    expect(window.location.hash).toBe('#h')
  })

  test('without a share ?view= still applies', () => {
    setLocation('view=board')
    const { container } = render(<App />)
    expect(container.querySelector('[data-testid="tab-board"]')).not.toBeNull()
  })
})

const VALID_VIEWS = [
  ['inbox', 'tab-inbox'],
  ['board', 'tab-board'],
  ['goals', 'tab-goals'],
  ['projects', 'tab-projects'],
  ['rules', 'tab-rules'],
  ['digest', 'tab-digest'],
  ['github', 'tab-github'],
  ['settings', 'tab-settings'],
]

describe('App tab selection via ?view=', () => {
  VALID_VIEWS.forEach(([view, testId]) => {
    test(`?view=${view} selects the matching tab`, () => {
      setLocation(`view=${view}`)
      const { container } = render(<App />)
      expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull()
    })
  })

  test('?view=connection, the old name, opens the settings tab', () => {
    setLocation('view=connection')
    const { container } = render(<App />)
    expect(container.querySelector('[data-testid="tab-settings"]')).not.toBeNull()
  })

  test('an unknown ?view= value falls back to mytasks', () => {
    setLocation('view=not-a-real-tab')
    const { container } = render(<App />)
    expect(container.querySelector('[data-testid="tab-mytasks"]')).not.toBeNull()
  })
})

describe('App URL mirroring', () => {
  test('the view param is removed for the default tab while other params and hash are preserved', () => {
    setLocation('view=mytasks&foo=bar', '#keep-me')
    render(<App />)
    const params = new URLSearchParams(window.location.search)
    expect(params.has('view')).toBe(false)
    expect(params.get('foo')).toBe('bar')
    expect(window.location.hash).toBe('#keep-me')
  })

  test('the view param is kept in the URL for a non-default tab, alongside other params and hash', () => {
    setLocation('view=inbox&foo=bar', '#keep-me')
    render(<App />)
    const params = new URLSearchParams(window.location.search)
    expect(params.get('view')).toBe('inbox')
    expect(params.get('foo')).toBe('bar')
    expect(window.location.hash).toBe('#keep-me')
  })

  test('no view param is added to the URL when already on the default tab with no query', () => {
    setLocation('')
    render(<App />)
    expect(window.location.search).toBe('')
  })
})

describe('App chat mockup gating', () => {
  test('the chat button and panel are absent without ?chat=mockup', () => {
    setLocation('')
    const { container } = render(<App />)
    expect(container.querySelector('button[aria-label="Ask Polaris"]')).toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  test('with ?chat=mockup the chat button appears and the panel starts closed', () => {
    setLocation('chat=mockup')
    const { container } = render(<App />)
    expect(container.querySelector('button[aria-label="Ask Polaris"]')).not.toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  test('with ?chat=mockup&open=1 the panel starts open', () => {
    setLocation('chat=mockup&open=1')
    const { container } = render(<App />)
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-label')).toBe('Ask Polaris')
  })

  test('open=1 without chat=mockup does nothing', () => {
    setLocation('open=1')
    const { container } = render(<App />)
    expect(container.querySelector('button[aria-label="Ask Polaris"]')).toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('App chat panel toggling', () => {
  test('clicking the chat button opens the panel and adds chat-docked to main, clicking again closes it', () => {
    setLocation('chat=mockup')
    const { container } = render(<App />)
    const main = container.querySelector('main')
    expect(main.classList.contains('chat-docked')).toBe(false)

    const chatButton = container.querySelector('button[aria-label="Ask Polaris"]')
    fireEvent.click(chatButton)

    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.querySelector('main').classList.contains('chat-docked')).toBe(true)

    fireEvent.click(container.querySelector('button[aria-label="Ask Polaris"]'))

    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('main').classList.contains('chat-docked')).toBe(false)
  })
})
