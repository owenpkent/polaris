import { expect } from '@playwright/test'
import { TOKEN } from './server.js'

// This worker's server port (set by the scratchServer fixture in e2e/fixtures.js).
export const port = () => Number(process.env.CC_UI_WORKER_PORT)

export const MIN_TARGET = 44

// Opens a dashboard view already connected to the test server.
export async function openView(page, view = 'mytasks', query = '') {
  const search = `?view=${view}${query ? `&${query}` : ''}`
  await page.goto(`/${search}#cc-url=http://127.0.0.1:${port()}&cc-token=${TOKEN}`)
  await page.waitForLoadState('networkidle')
}

// Like openView, without waiting for the network to go idle: for a view whose first request is
// held or delayed (see holdRequest and delayRequest below), where networkidle would never come,
// or would come only once the delay has already passed.
export async function gotoView(page, view) {
  await page.goto(`/?view=${view}#cc-url=http://127.0.0.1:${port()}&cc-token=${TOKEN}`)
}

// True when the project's viewport is under the dashboard's one breakpoint (640px, CLAUDE.md), so
// a phone turned sideways (844px wide) gets the desktop expectations, as it gets the desktop layout.
export function isPhone(testInfo) {
  return testInfo.project.use.viewport.width < 640
}

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Creates a task due today straight through the REST API, so a test that changes data works on
// its own task and leaves the seeded ones alone. Titles carry the project name and a counter so
// the desktop and phone runs never collide.
let created = 0
export async function createTask(request, testInfo, label, extra = {}) {
  const title = `UI test ${label} ${testInfo.project.name} ${++created}`
  const res = await request.post('/api/tasks', {
    headers: { Authorization: `Bearer ${TOKEN}` },
    data: { title, dueAt: localToday(), ...extra },
  })
  expect(res.ok(), `create task failed: ${res.status()}`).toBeTruthy()
  return title
}

// Creates a task with a thread and the given posts straight through the REST API
// (docs/agent-threads-proposal.md, stage 1), for a test or a shot that needs a thread to look at.
// Each post is { type, body } and lands as the owner's. Returns the task's title and id.
export async function seedThread(request, testInfo, label, posts = []) {
  const headers = { Authorization: `Bearer ${TOKEN}` }
  const title = `UI test thread ${label} ${testInfo.project.name} ${++created}`
  const task = await request.post('/api/tasks', { headers, data: { title, dueAt: localToday() } })
  expect(task.ok(), `create task failed: ${task.status()}`).toBeTruthy()
  const { task: { id } } = await task.json()
  const thread = await request.post(`/api/tasks/${id}/thread`, { headers, data: {} })
  expect(thread.ok(), `create thread failed: ${thread.status()}`).toBeTruthy()
  const { thread: { id: threadId } } = await thread.json()
  for (const post of posts) {
    const res = await request.post(`/api/threads/${threadId}/posts`, { headers, data: post })
    expect(res.ok(), `post failed: ${res.status()}`).toBeTruthy()
  }
  return { title, id, threadId }
}

// Titles of real tasks. Inbox suggestions are stored as tasks with status "inbox" (and rejected
// ones as "dropped"), so they are left out: only an accepted suggestion counts as a task.
const ACTIVE = new Set(['open', 'in_progress', 'waiting'])
export async function listTaskTitles(request) {
  const res = await request.get('/api/tasks', { headers: { Authorization: `Bearer ${TOKEN}` } })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  return (body.tasks || []).filter((t) => ACTIVE.has(t.status)).map((t) => t.title)
}

// Opens a task's detail panel by clicking its title. Clicking the middle of a desktop row would
// land on an inline cell (due date, project, priority) and open that cell's menu instead.
export async function openTask(page, title) {
  const row = page.getByRole('button', { name: `Open ${title}`, exact: true })
  await row.getByText(title, { exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible()
  return row
}

// The page itself must never scroll sideways (CONTRIBUTING.md, "Responsive").
export async function expectNoHorizontalOverflow(page) {
  const { inner, scroll } = await page.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  expect(scroll, `page scrolls sideways: scrollWidth ${scroll} > innerWidth ${inner}`).toBeLessThanOrEqual(inner)
}

// Every visible control in `scope` matching `selector` must offer a 44px click target
// (CLAUDE.md). Returns the offenders as readable strings so a failure names them.
export async function smallTargets(scope, selector = 'button, [role="button"], select') {
  return scope.locator(selector).evaluateAll((els, min) => {
    const out = []
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (r.width < min - 0.5 || r.height < min - 0.5) {
        const label = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40) || el.className
        out.push(`${el.tagName.toLowerCase()} "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`)
      }
    }
    return out
  }, MIN_TARGET)
}

// The focused element must show a visible focus ring: an outline at least 2px wide whose colour
// reaches 3:1 against the surface it is drawn on (CONTRIBUTING.md, the number for control edges),
// in whichever theme the project runs. The surface is the first opaque background behind the
// ring: the element's own when the outline is drawn inside it, otherwise the nearest ancestor's.
export async function expectFocusRing(page) {
  const ring = await page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return null
    const s = getComputedStyle(el)
    const parse = (c) => {
      const m = (c.match(/[\d.]+/g) || []).map(Number)
      return m.length >= 3 ? { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } : null
    }
    const opaque = (node) => {
      const c = parse(getComputedStyle(node).backgroundColor)
      return c && c.a >= 0.99 ? c : null
    }
    let node = (parseFloat(s.outlineOffset) || 0) < 0 ? el : el.parentElement
    let surface = null
    while (node && !surface) {
      surface = opaque(node)
      node = node.parentElement
    }
    const luminance = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const colour = parse(s.outlineColor)
    let contrast = null
    if (colour && surface) {
      const [hi, lo] = [luminance(colour), luminance(surface)].sort((a, b) => b - a)
      contrast = (hi + 0.05) / (lo + 0.05)
    }
    return {
      style: s.outlineStyle,
      width: parseFloat(s.outlineWidth) || 0,
      tag: el.tagName,
      colour: s.outlineColor,
      surface: surface ? `rgb(${surface.r}, ${surface.g}, ${surface.b})` : null,
      contrast,
    }
  })
  expect(ring, 'nothing is focused').not.toBeNull()
  expect(ring.style, `${ring.tag} has no outline when focused`).not.toBe('none')
  expect(ring.width).toBeGreaterThanOrEqual(2)
  expect(ring.surface, `no opaque surface found behind the focus ring on ${ring.tag}`).not.toBeNull()
  expect(ring.contrast, `focus ring ${ring.colour} on ${ring.surface} is under 3:1`).toBeGreaterThanOrEqual(3)
}

// Creates a goal through the REST API, for tests that change a goal. Returns its title.
export async function createGoal(request, testInfo, label, extra = {}) {
  const title = `UI test goal ${label} ${testInfo.project.name} ${++created}`
  const res = await request.post('/api/goals', { headers: { Authorization: `Bearer ${TOKEN}` }, data: { title, ...extra } })
  expect(res.ok(), `create goal failed: ${res.status()}`).toBeTruthy()
  return title
}

// Two visible targets in `scope` that sit side by side closer than `gap` pixels, unless one
// contains the other. A tremor that lands 8px off a 44px button must not land on its neighbour
// (initiatives/ui-ux-testing.md, phase 7). Rows stacked in a menu or a drawer touch by design and
// are 44px tall each, so only pairs whose vertical extents overlap count: neighbours across, not
// neighbours down. Returns readable pairs so a failure names them.
export async function crowdedTargets(scope, selector = 'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], a[href], input, select', gap = 8) {
  return scope.locator(selector).evaluateAll((els, min) => {
    const boxes = []
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      boxes.push({ el, r })
    }
    const label = (el) => el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName.toLowerCase()
    const out = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue
        const dx = Math.max(a.r.left - b.r.right, b.r.left - a.r.right, 0)
        const dy = Math.max(a.r.top - b.r.bottom, b.r.top - a.r.bottom, 0)
        const sideBySide = dy === 0 && a.r.top < b.r.bottom && b.r.top < a.r.bottom
        if (sideBySide && dx < min) out.push(`"${label(a.el)}" and "${label(b.el)}" are ${Math.round(dx)}px apart`)
      }
    }
    return out
  }, gap)
}

// Makes the dashboard poll /api/events now instead of at its next interval: useEvents.js restarts
// its poll on a visibility change. A test that wrote through the API calls this so the refresh
// arrives at once rather than up to ten seconds later.
export async function nudgePoll(page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
}

// The states between success and failure (initiatives/ui-ux-testing.md, phase 5), shared by
// e2e/states.spec.js (the flow tests) and e2e/shots.spec.js (their screenshots). `page.route`
// shapes the answer to the one request each view is about; the server is never changed.

// Half a second is enough to see the loading state; two seconds a view, at eight views in two
// projects, was half a minute of every run.
export const SLOW_MS = 500

// What api.js reads from a failed answer: `error.message` becomes the banner text.
export const FAILURE = { error: { code: 'internal_error', message: 'The UI test server answered 500 on purpose.' } }

// One row per view: the request the view is about (a predicate over the URL, so the query string
// My tasks adds does not matter), what shared.jsx's Loading shows, the smallest valid empty
// payload, the prose and controls the empty state offers, and something only the seeded data
// shows, to know the real answer arrived.
export const VIEWS = [
  {
    id: 'mytasks',
    label: 'My tasks',
    request: (url) => url.pathname === '/api/tasks',
    loading: 'Loading tasks…',
    emptyBody: { tasks: [] },
    // No EmptyState here: the Today and Tomorrow groups always render, each with an Add task
    // row, and the toolbar keeps its Add task button. The way forward is the control, not a
    // sentence.
    emptyText: [],
    emptyControls: ['Collapse Today', 'Collapse Tomorrow', 'Add task'],
    ready: (page) => page.getByRole('button', { name: 'Open Reply to accessibility audit feedback', exact: true }),
  },
  {
    id: 'inbox',
    label: 'Inbox',
    request: (url) => url.pathname === '/api/inbox',
    loading: 'Loading inbox…',
    emptyBody: { tasks: [] },
    emptyText: ['Inbox is empty.', 'Suggested tasks from GitHub. Nothing becomes a task until you accept it.'],
    emptyControls: [],
    ready: (page, testInfo) => page.getByRole(isPhone(testInfo) ? 'list' : 'table', { name: 'Inbox' }),
  },
  {
    id: 'board',
    label: 'Board',
    // Board loads the project list, picks one, then loads that project. The board itself is
    // the second request; its empty state is the first one's (no projects, nothing to pick).
    request: (url) => /^\/api\/projects\/[^/]+$/.test(url.pathname),
    emptyRequest: (url) => url.pathname === '/api/projects',
    loading: 'Loading board…',
    emptyBody: { projects: [] },
    emptyText: ['No projects yet', 'Projects will appear here once they exist on the server.'],
    emptyControls: [],
    ready: (page) => page.getByRole('region', { name: 'Backlog', exact: true }),
  },
  {
    id: 'goals',
    label: 'Goals',
    request: (url) => url.pathname === '/api/goals',
    loading: 'Loading goals…',
    emptyBody: { goals: [], total: 0, vision: '' },
    emptyText: ['No goals yet', 'Add one, then link the projects and tasks that move it.'],
    emptyControls: ['Add goal'],
    ready: (page) => page.getByRole('button', { name: 'Show details for Ship the UI test project', exact: true }),
  },
  {
    id: 'projects',
    label: 'Projects',
    request: (url) => url.pathname === '/api/projects',
    loading: 'Loading projects…',
    emptyBody: { projects: [] },
    emptyText: ['No projects yet', 'Add one to start filing tasks under it.'],
    emptyControls: ['New project'],
    ready: (page) => page.getByRole('article', { name: 'UI Test Project', exact: true }),
  },
  {
    id: 'rules',
    label: 'Rules',
    request: (url) => url.pathname === '/api/rules',
    loading: 'Loading rules…',
    emptyBody: { rules: [] },
    emptyText: ['No rules yet', 'Create one above to automate triage.'],
    emptyControls: ['Create rule'],
    ready: (page) => page.getByText('Notify when a task is overdue').first(),
  },
  {
    id: 'digest',
    label: 'Digest',
    // /api/sync (the job strip) is left alone: the digest is the request this view is about.
    request: (url) => url.pathname === '/api/digest',
    loading: 'Loading digest…',
    emptyBody: { date: null, markdown: '' },
    emptyText: ['No digest yet', 'Run a sync job above, then refresh.'],
    emptyControls: ['Refresh'],
    ready: (page) => page.getByRole('heading', { level: 2 }).filter({ hasText: 'Command Center Digest' }),
  },
  {
    id: 'github',
    label: 'GitHub',
    request: (url) => url.pathname === '/api/github/status',
    loading: 'Loading GitHub status…',
    // The status endpoint's shape with no app and nobody signed in (github-routes.ts).
    emptyBody: { mode: 'none', app: null, user: null, signedIn: false, refreshExpiresAt: null, installations: [] },
    emptyText: ['Not connected.', 'Create the app on GitHub'],
    emptyControls: ['Create app'],
    // The test server is signed in to the fake GitHub (global-setup.js, CC_GITHUB_FAKE=1), so the
    // real answer reads as signed in, unlike the empty one.
    ready: (page) => page.getByText('Read-only, signed in as ui-test-user.'),
  },
]

const isGet = (route) => route.request().method() === 'GET'

function fulfilJson(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// Answers a GET matching `request` with the real response after SLOW_MS. Other methods pass.
export async function delayRequest(page, request) {
  await page.route(request, async (route) => {
    if (!isGet(route)) return route.fallback()
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
    // The dashboard may have given up on this request meanwhile (a re-render cancels the first
    // fetch of a view), or the test may already be over: answering a request that is gone is not
    // a failure of the test, so this handler is best effort and never throws.
    try {
      const response = await route.fetch()
      await route.fulfill({ response })
    } catch {
      // gone
    }
  })
}

// Answers a GET matching `request` by never answering at all: the route stays open until the
// page or the test goes away. Unlike delayRequest, there is no clock to race against, so a shot
// taken once the loading text appears is never at risk of the real answer landing first.
export async function holdRequest(page, request) {
  await page.route(request, (route) => (isGet(route) ? new Promise(() => {}) : route.fallback()))
}

export async function failRequest(page, request) {
  await page.route(request, (route) => (isGet(route) ? fulfilJson(route, 500, FAILURE) : route.fallback()))
}

export async function emptyRequest(page, request, body) {
  await page.route(request, (route) => (isGet(route) ? fulfilJson(route, 200, body) : route.fallback()))
}

export const failureBanner = (page) => page.getByRole('alert').filter({ hasText: FAILURE.error.message })
