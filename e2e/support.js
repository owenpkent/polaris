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

// The navigation for the project's layout: the always-visible sidebar on desktop, or on a phone
// the drawer, opened from the top bar's menu button. Both list the views as buttons.
export async function openNavigation(page, testInfo) {
  if (!isPhone(testInfo)) {
    const sidebar = page.getByRole('navigation', { name: 'Navigation' })
    await expect(sidebar).toBeVisible()
    return sidebar
  }
  await page.getByRole('button', { name: 'Open navigation' }).click()
  const drawer = page.getByRole('dialog', { name: 'Navigation' })
  await expect(drawer).toBeVisible()
  return drawer
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
// (docs/agent-threads-proposal.md), for a test or a shot that needs a thread to look at.
// Each post is { type, body } and lands as the owner's. `opts` applies the owner's judgement
// afterwards (stage 2): `judge` is { postIndex, status }, `pin` a post index, `close` true, and
// `fork` the title of the successor thread, which closes this one.
// Returns the task's title and id, the thread id, and the post ids in order.
export async function seedThread(request, testInfo, label, posts = [], opts = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}` }
  const title = `UI test thread ${label} ${testInfo.project.name} ${++created}`
  const task = await request.post('/api/tasks', { headers, data: { title, dueAt: localToday() } })
  expect(task.ok(), `create task failed: ${task.status()}`).toBeTruthy()
  const { task: { id } } = await task.json()
  const thread = await request.post(`/api/tasks/${id}/thread`, { headers, data: {} })
  expect(thread.ok(), `create thread failed: ${thread.status()}`).toBeTruthy()
  const { thread: { id: threadId } } = await thread.json()
  const postIds = []
  for (const post of posts) {
    const res = await request.post(`/api/threads/${threadId}/posts`, { headers, data: post })
    expect(res.ok(), `post failed: ${res.status()}`).toBeTruthy()
    postIds.push((await res.json()).post.id)
  }
  if (opts.judge) {
    const res = await request.patch(`/api/posts/${postIds[opts.judge.postIndex]}`, { headers, data: { status: opts.judge.status } })
    expect(res.ok(), `judge failed: ${res.status()}`).toBeTruthy()
  }
  if (opts.pin != null) {
    const res = await request.patch(`/api/threads/${threadId}`, { headers, data: { pinnedPostId: postIds[opts.pin] } })
    expect(res.ok(), `pin failed: ${res.status()}`).toBeTruthy()
  }
  if (opts.close) {
    const res = await request.post(`/api/threads/${threadId}/close`, { headers })
    expect(res.ok(), `close failed: ${res.status()}`).toBeTruthy()
  }
  let successor = null
  if (opts.fork) {
    const res = await request.post(`/api/threads/${threadId}/fork`, { headers, data: { title: opts.fork } })
    expect(res.ok(), `fork failed: ${res.status()}`).toBeTruthy()
    successor = (await res.json()).successor
  }
  return { title, id, threadId, postIds, successor }
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
    id: 'checklists',
    label: 'Checklists',
    request: (url) => url.pathname === '/api/checklists',
    loading: 'Loading checklists…',
    emptyBody: { checklists: [] },
    emptyText: ['No checklists yet', 'Make one for anything you do again and again, like packing or cleaning.'],
    emptyControls: ['New checklist'],
    ready: (page) => page.getByRole('article', { name: 'Packing: weekend trip', exact: true }),
  },
  {
    id: 'threads',
    label: 'Threads',
    request: (url) => url.pathname === '/api/threads',
    loading: 'Loading threads…',
    emptyBody: { threads: [] },
    emptyText: ['No open threads', "A thread starts from a task's panel, under Thread."],
    emptyControls: ['Open threads'],
    // The Open/Closed switch is there whatever the list holds, so it stands for the page being
    // ready; the tests that make threads run beside this one on the same database.
    ready: (page) => page.getByRole('button', { name: 'Open threads', exact: true }),
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

// Holds every GET matching `request` until the test calls the returned release(), then answers
// each with the real response. Unlike delayRequest there is no clock: the loading state lasts as
// long as the test needs to see it, however late a cold browser draws it. Best effort after
// release, like delayRequest, because the page may have dropped the request meanwhile.
export async function gateRequest(page, request) {
  let open
  const opened = new Promise((resolve) => { open = resolve })
  await page.route(request, async (route) => {
    if (!isGet(route)) return route.fallback()
    await opened
    try {
      const response = await route.fetch()
      await route.fulfill({ response })
    } catch {
      // gone
    }
  })
  return () => open()
}

export async function failRequest(page, request) {
  await page.route(request, (route) => (isGet(route) ? fulfilJson(route, 500, FAILURE) : route.fallback()))
}

export async function emptyRequest(page, request, body) {
  await page.route(request, (route) => (isGet(route) ? fulfilJson(route, 200, body) : route.fallback()))
}

export const failureBanner = (page) => page.getByRole('alert').filter({ hasText: FAILURE.error.message })

// What GET /api/update says when the scheduled updater has reported a newer signed release
// (command-center/src/http/update-routes.ts). The real test server has no status file, so it
// never shows the icon; a test that wants it routes the answer with fakeUpdate.
export const UPDATE_AVAILABLE = {
  running: '2.0.0',
  updaterInstalled: true,
  available: {
    version: '2.1.0',
    notes: 'Adds the update icon to the dashboard.\n\nThe digest footer no longer repeats the date.\nBackups older than the keep count are listed before they go.',
    touchesSchema: true,
  },
  request: null,
  lastResult: null,
  command: 'npm run cc -- update --release',
}

// What it says after that update went in: nothing newer is named, and the status file carries
// the result, which the icon shows once until it is dismissed.
export const UPDATE_INSTALLED = {
  ...UPDATE_AVAILABLE,
  running: '2.1.0',
  available: null,
  lastResult: { ok: true, message: 'Updated to v2.1.0', at: '2026-10-06T04:05:00.000Z', version: '2.1.0' },
}

// Answers GET /api/update with `body`. Other methods pass through to the real server.
export async function fakeUpdate(page, body = UPDATE_AVAILABLE) {
  await page.route((url) => url.pathname === '/api/update', (route) => (isGet(route) ? fulfilJson(route, 200, body) : route.fallback()))
}

// Content the user cannot see in full (CONTRIBUTING.md, "Nothing is cut off"). Returns readable
// strings, one per problem, so a failure names each one:
//
// - text clipped by a box that hides overflow, sideways or downwards, unless it is an ellipsis on
//   text whose full wording is still on the page in a `title` or an accessible name above it;
// - text or a control that sits outside the viewport sideways, or outside a scroll box's
//   scrollable area (overflow to the left or top of a scroller can never be scrolled to);
// - a control that, scrolled to the middle of the screen as far as it will go, is still cut off by
//   a box, runs off the screen, or has something else drawn over its middle (a sticky bar, the
//   bottom tab bar, the floating New task button, a sheet).
//
// Positioned elements are only clipped by the boxes that really clip them: an absolute element
// escapes static ancestors up to its containing block, a fixed one escapes all of them. Text that
// is visually hidden on purpose (the 1px sr-only pattern, `clip`, `clip-path`) is skipped.
// Every scroll position it moves is put back before it returns.
export async function clippedContent(page, scope = page.locator('body')) {
  return scope.evaluate((root) => {
    // With a menu or a modal open, only that layer is checked: whatever it covers is meant to be
    // covered. A menu or popover (Menu.jsx marks its portal data-popover) wins over the dialog it
    // opened from.
    if (root === document.body) {
      const open = (sel) => [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden')
      root = open('[data-popover], [role="menu"], [role="listbox"]').pop() || open('[aria-modal="true"]').pop() || root
    }
    const TOL = 1
    const TOL_Y = 3 // a glyph's ascent and descent can poke past a tight line box
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const out = []
    const seen = new Set()
    const report = (msg) => { if (!seen.has(msg)) { seen.add(msg); out.push(msg) } }
    const name = (el) => {
      const label = el.getAttribute('aria-label') || el.labels?.[0]?.textContent.trim() || el.getAttribute('title') || (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
      return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} "${label}"`
    }
    const box = (el) => {
      const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
      return `${el.tagName.toLowerCase()}${cls}`
    }

    // Hidden on purpose: not rendered, transparent, or the sr-only clip.
    const hidden = (el) => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n)
        if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true
        if (Number(s.opacity) === 0) return true
        if (s.clip && s.clip !== 'auto') return true
        if (s.clipPath && s.clipPath !== 'none') return true
        const r = n.getBoundingClientRect()
        if (s.overflow !== 'visible' && (r.width <= 1 || r.height <= 1)) return true
      }
      return false
    }

    // The boxes that clip `el`, nearest first, honouring containing blocks. Text is clipped by its
    // own element too (`self`); a control's box is the thing measured, so its own overflow is not.
    const clippers = (el, self) => {
      const list = []
      const modeOf = (p) => (p === 'absolute' || p === 'fixed' ? p : 'flow')
      let mode = self ? 'flow' : modeOf(getComputedStyle(el).position)
      for (let n = self ? el : el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n)
        const containing = s.transform !== 'none' || s.filter !== 'none' || /paint|layout|strict|content/.test(s.contain) || s.willChange.includes('transform')
        const holds = mode === 'flow' || (mode === 'absolute' && (s.position !== 'static' || containing)) || (mode === 'fixed' && containing)
        if (holds) {
          if (s.overflowX !== 'visible' || s.overflowY !== 'visible') list.push({ el: n, s })
          mode = modeOf(s.position)
        }
      }
      return list
    }
    // The nearest fixed ancestor of el, if any: such content does not move
    // with the page, so the viewport's bottom edge is a hard edge for it.
    const fixedLayer = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === 'fixed') return n
      }
      return null
    }
    const scrolls = (v) => v === 'auto' || v === 'scroll'
    const padBox = (n) => {
      const r = n.getBoundingClientRect()
      const left = r.left + n.clientLeft
      const top = r.top + n.clientTop
      return { left, top, right: left + n.clientWidth, bottom: top + n.clientHeight }
    }

    // Checks one rectangle against its clipping boxes. `scrolled` says the owner was just
    // scrolled into view, so a scroll box is held to its visible area, not its scrollable one.
    // Once a box has clipped (and the clip reported or excused), the rectangle is cut down to what
    // that box shows, so the boxes around it are not blamed for the same overflow.
    const check = (r0, el, what, scrolled) => {
      const problems = []
      const self = !scrolled
      let r = { left: r0.left, right: r0.right, top: r0.top, bottom: r0.bottom }
      for (const { el: c, s } of clippers(el, self)) {
        const b = padBox(c)
        for (const axis of ['x', 'y']) {
          const ov = axis === 'x' ? s.overflowX : s.overflowY
          if (ov === 'visible') continue
          const [lo, hi, rlo, rhi, tol] = axis === 'x' ? [b.left, b.right, r.left, r.right, TOL] : [b.top, b.bottom, r.top, r.bottom, TOL_Y]
          if (scrolls(ov)) {
            const before = axis === 'x' ? c.scrollLeft : c.scrollTop
            const extent = axis === 'x' ? c.scrollWidth : c.scrollHeight
            const start = rlo - lo + before
            if (start < -tol) problems.push(`${what} starts ${Math.round(-start)}px before the scrollable area of ${box(c)}, where it can never be scrolled to`)
            else if (scrolled && rhi - rlo <= hi - lo && (rlo < lo - tol || rhi > hi + tol)) problems.push(`${what} cannot be scrolled fully into view inside ${box(c)}`)
            else if (start + (rhi - rlo) > extent + tol) problems.push(`${what} ends past the scrollable area of ${box(c)}`)
          } else if (rlo < lo - tol || rhi > hi + tol) {
            const by = Math.round(Math.max(lo - rlo, rhi - hi))
            // A line clamp draws its own ellipsis on the last line it keeps.
            const ellipsis = axis === 'x' ? s.textOverflow === 'ellipsis' : (s.webkitLineClamp || 'none') !== 'none'
            problems.push({ ellipsis, c, msg: `${what} is cut off ${by}px ${axis === 'x' ? 'sideways' : 'at the top or bottom'} by ${box(c)}${ellipsis ? ' (ellipsis)' : ''}` })
            if (axis === 'x') r = { ...r, left: Math.max(r.left, lo), right: Math.min(r.right, hi) }
            else r = { ...r, top: Math.max(r.top, lo), bottom: Math.min(r.bottom, hi) }
          }
        }
      }
      // The page itself never scrolls sideways, so the viewport's sides are hard edges. Content in
      // a sideways scroll box only has to be reachable in it, so the box is held to the edges.
      // Content in a fixed layer does not move with the page, so the top and bottom are hard
      // edges for it too, or for the scroll box inside the layer that holds it.
      const list = clippers(el, self)
      const xBox = scrolled ? null : list.filter(({ s }) => scrolls(s.overflowX)).pop()
      const x = xBox ? xBox.el.getBoundingClientRect() : r
      if (x.left < -TOL || x.right > vw + TOL) problems.push(`${xBox ? `the scroll box ${box(xBox.el)} holding ${what}` : what} runs ${Math.round(Math.max(-x.left, x.right - vw))}px off the side of the screen`)
      const layer = fixedLayer(el)
      if (layer) {
        const yBox = scrolled ? null : list.find(({ el: c, s }) => scrolls(s.overflowY) && layer.contains(c))
        const y = yBox ? yBox.el.getBoundingClientRect() : r
        if (y.bottom - y.top <= vh && (y.top < -TOL_Y || y.bottom > vh + TOL_Y)) problems.push(`${yBox ? `the scroll box ${box(yBox.el)} holding ${what}` : what} runs ${Math.round(Math.max(-y.top, y.bottom - vh))}px off the top or bottom of the screen`)
      }
      return problems
    }

    // An ellipsis is allowed when the full text is still exposed: a title on the clipping box or
    // above it, or an accessible name above it that contains the text. Never inside a dialog.
    const fullTextExposed = (text, c) => {
      // A panel or dialog is where text is read in full, so nothing in one is excused.
      if (c.closest('[role="dialog"]')) return false
      for (let n = c; n && n !== document.body; n = n.parentElement) {
        const t = n.getAttribute('title') || n.getAttribute('aria-label') || ''
        if (t.includes(text)) return true
      }
      return false
    }

    // Remember every scroll position, so the checks leave the page as they found it.
    const saved = [...document.querySelectorAll('*')].filter((n) => n.scrollTop || n.scrollLeft).map((n) => [n, n.scrollTop, n.scrollLeft])
    const page = [window.scrollX, window.scrollY]

    // Text first, measured where it is now against each box's scrollable area.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = t.textContent.trim()
      if (!text) continue
      const el = t.parentElement
      if (!el || hidden(el) || el.closest('script, style, noscript, svg, option')) continue
      const range = document.createRange()
      range.selectNodeContents(t)
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
      if (!rects.length) continue
      const union = rects.reduce((a, r) => ({ left: Math.min(a.left, r.left), right: Math.max(a.right, r.right), top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom) }))
      // One line at a time vertically (a long paragraph is taller than its scroller by design),
      // and the whole run sideways.
      const problems = [...check(union, el, `text "${text.slice(0, 40)}"`, false).filter((p) => typeof p === 'string' || !p.msg.includes('top or bottom')),
        ...rects.flatMap((r) => check(r, el, `text "${text.slice(0, 40)}"`, false).filter((p) => typeof p !== 'string' && p.msg.includes('top or bottom')))]
      for (const p of problems) {
        if (typeof p === 'string') report(p)
        else if (!(p.ellipsis && fullTextExposed(text, p.c))) report(p.msg)
      }
    }

    // Form fields hold their text in a value, not a text node. A text box that grows with its text
    // (overflow hidden) must show every line, and in a panel or dialog, where text is read in full,
    // a one-line field's value must fit its box.
    const TEXTY = new Set(['', 'text', 'search', 'url', 'email', 'tel'])
    for (const field of root.querySelectorAll('textarea, input')) {
      // Squeezed shut (a flex column shrinking an overflow: hidden box): as wide as ever, but no
      // taller than a hairline. Not the 1px sr-only pattern, which is narrow too.
      const fr = field.getBoundingClientRect()
      if (fr.width > 8 && fr.height < 2 && field.parentElement && !hidden(field.parentElement) && getComputedStyle(field).position !== 'absolute') {
        report(`${name(field)} is squeezed to ${Math.round(fr.height)}px tall`)
        continue
      }
      if (hidden(field) || !field.value) continue
      const s = getComputedStyle(field)
      if (field.tagName === 'TEXTAREA') {
        if (!scrolls(s.overflowY) && field.scrollHeight > field.clientHeight + 1) report(`the text in ${name(field)} is cut off ${field.scrollHeight - field.clientHeight}px at the bottom`)
      } else if (TEXTY.has(field.type) && field.closest('[role="dialog"]') && field.scrollWidth > field.clientWidth + 1) {
        report(`the value of ${name(field)} is cut off ${field.scrollWidth - field.clientWidth}px sideways`)
      }
    }

    // Then controls, each scrolled to the middle of the screen first.
    const controls = root.querySelectorAll('button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, summary, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"], [role="radio"]')
    for (const el of controls) {
      if (hidden(el)) continue
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      for (const p of check(r, el, name(el), true)) report(typeof p === 'string' ? p : p.msg)
      if (r.bottom - r.top > vh || r.right - r.left > vw) continue
      const cx = Math.min(Math.max((r.left + r.right) / 2, 0), vw - 1)
      const cy = Math.min(Math.max((r.top + r.bottom) / 2, 0), vh - 1)
      const hit = document.elementFromPoint(cx, cy)
      if (hit && !el.contains(hit) && !hit.contains(el) && !(el.labels && [...el.labels].some((l) => l.contains(hit)))) {
        report(`${name(el)} is covered by ${box(hit)} ${name(hit)}`)
      }
    }

    for (const [n, top, left] of saved) { n.scrollTop = top; n.scrollLeft = left }
    for (const n of document.querySelectorAll('*')) {
      if (!saved.some(([s]) => s === n) && (n.scrollTop || n.scrollLeft)) { n.scrollTop = 0; n.scrollLeft = 0 }
    }
    window.scrollTo({ left: page[0], top: page[1], behavior: 'instant' })
    return out
  })
}

// Focus rings that do not show in full (CONTRIBUTING.md, "Nothing is cut off"). Measured on the
// rendered pixels, since a ring can be lost in ways no style reveals: clipped by a box that hides
// overflow, painted over by the next row's background or a sticky header, or run off the screen.
// Each control in `scope` (or in the open menu, popover, or modal, as clippedContent picks) is
// scrolled to the middle of the screen, focused as from the keyboard, and photographed with its
// ring and with the ring made transparent; along each straight side of the ring, the share of positions where nothing
// changed is the share of the ring that is hidden. Returns one line per side hidden by more than
// a tenth, and puts focus and scrolling back as they were.
export async function hiddenFocusRings(page, scope = page.locator('body'), selector = 'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, summary, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"], [role="radio"], [tabindex="0"]') {
  // A key press makes the next programmatic focus count as keyboard focus (:focus-visible).
  await page.keyboard.press('Shift')
  const layer = await scope.evaluateHandle((root) => {
    if (root !== document.body) return root
    const open = (sel) => [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden')
    return open('[data-popover], [role="menu"], [role="listbox"]').pop() || open('[aria-modal="true"]').pop() || root
  })
  const state = await page.evaluateHandle(() => ({
    active: document.activeElement,
    scrolls: [...document.querySelectorAll('*')].filter((n) => n.scrollTop || n.scrollLeft).map((n) => [n, n.scrollTop, n.scrollLeft]),
    page: [window.scrollX, window.scrollY],
  }))
  const controls = await layer.evaluateHandle((root, sel) => [...root.querySelectorAll(sel)], selector)
  const count = await controls.evaluate((list) => list.length)
  const out = []
  for (let i = 0; i < count; i++) {
    const ring = await controls.evaluate((list, i) => {
      const el = list[i]
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n)
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null
      }
      if (el.disabled || el.getAttribute('aria-hidden') === 'true') return null
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      el.focus({ preventScroll: true })
      if (document.activeElement !== el || !el.matches(':focus-visible')) return null
      const s = getComputedStyle(el)
      const width = parseFloat(s.outlineWidth) || 0
      if (s.outlineStyle === 'none' || width === 0) return null
      const offset = parseFloat(s.outlineOffset) || 0
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return null
      const radius = parseFloat(s.borderTopLeftRadius) || 0
      const label = el.getAttribute('aria-label') || (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || el.tagName.toLowerCase()
      return {
        label: `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} "${label}"`,
        outer: { left: r.left - offset - width, top: r.top - offset - width, right: r.right + offset + width, bottom: r.bottom + offset + width },
        width,
        colour: (s.outlineColor.match(/[\d.]+/g) || []).slice(0, 3).map(Number),
        corner: Math.max(0, radius + offset) + width + 2,
        vw: document.documentElement.clientWidth,
        vh: window.innerHeight,
      }
    }, i)
    if (!ring) continue
    const { outer, vw, vh } = ring
    const clip = {
      x: Math.max(0, Math.floor(outer.left) - 2),
      y: Math.max(0, Math.floor(outer.top) - 2),
    }
    clip.width = Math.min(vw, Math.ceil(outer.right) + 2) - clip.x
    clip.height = Math.min(vh, Math.ceil(outer.bottom) + 2) - clip.y
    if (clip.width <= 0 || clip.height <= 0) {
      out.push(`focus ring of ${ring.label} is off the screen`)
      continue
    }
    const focused = (await page.screenshot({ clip, scale: 'css', animations: 'disabled', caret: 'hide' })).toString('base64')
    // The same moment without the ring: still focused, so nothing else that focus changes (a
    // border colour, a :focus-within highlight) counts as ring. Blurring would not do: a field
    // that takes focus back would photograph the same twice.
    const before = await controls.evaluate((list, i) => {
      const el = list[i]
      const prior = [el.style.getPropertyValue('outline-color'), el.style.getPropertyPriority('outline-color')]
      el.style.setProperty('outline-color', 'transparent', 'important')
      return prior
    }, i)
    const plain = (await page.screenshot({ clip, scale: 'css', animations: 'disabled', caret: 'hide' })).toString('base64')
    await controls.evaluate((list, [i, [value, priority]]) => {
      list[i].style.removeProperty('outline-color')
      if (value) list[i].style.setProperty('outline-color', value, priority)
      list[i].blur()
    }, [i, before])
    const hidden = await page.evaluate(async ({ focused, plain, ring, clip }) => {
      const decode = async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const canvas = new OffscreenCanvas(bmp.width, bmp.height)
        const g = canvas.getContext('2d')
        g.drawImage(bmp, 0, 0)
        return g.getImageData(0, 0, bmp.width, bmp.height)
      }
      const [a, b] = await Promise.all([decode(focused), decode(plain)])
      const changed = (x, y) => {
        // Outside the photo is outside the screen: nothing of the ring shows there.
        if (x < 0 || y < 0 || x >= a.width || y >= a.height) return false
        const k = (y * a.width + x) * 4
        const far = (d, c) => Math.max(Math.abs(d[k] - c[0]), Math.abs(d[k + 1] - c[1]), Math.abs(d[k + 2] - c[2]))
        // Shown: the ring changed the pixel, or the pixel is the ring's colour already (a ring
        // drawn over a line of its own colour changes nothing and is still seen).
        return far(a.data, [b.data[k], b.data[k + 1], b.data[k + 2]]) >= 40 || (ring.colour.length === 3 && far(a.data, ring.colour) < 24)
      }
      // Local coordinates of the ring's outer edge in the photo.
      const L = ring.outer.left - clip.x, T = ring.outer.top - clip.y, R = ring.outer.right - clip.x, B = ring.outer.bottom - clip.y
      const band = Math.ceil(ring.width) + 1
      const side = (along, across) => {
        let seen = 0, total = 0
        for (const p of along) {
          total++
          if (across.some(([x, y]) => changed(Math.round(x(p)), Math.round(y(p))))) seen++
        }
        return total ? 1 - seen / total : 0
      }
      const range = (from, to) => { const out = []; for (let v = Math.ceil(from); v <= Math.floor(to); v++) out.push(v); return out }
      const xs = range(L + ring.corner, R - ring.corner)
      const ys = range(T + ring.corner, B - ring.corner)
      const offsets = range(-1, band - 1)
      const result = {}
      if (xs.length) {
        result.top = side(xs, offsets.map((d) => [(p) => p, () => T + d]))
        result.bottom = side(xs, offsets.map((d) => [(p) => p, () => B - 1 - d]))
      }
      if (ys.length) {
        result.left = side(ys, offsets.map((d) => [() => L + d, (p) => p]))
        result.right = side(ys, offsets.map((d) => [() => R - 1 - d, (p) => p]))
      }
      return result
    }, { focused, plain, ring, clip })
    for (const [name, share] of Object.entries(hidden)) {
      if (share > 0.1) out.push(`focus ring of ${ring.label} is ${Math.round(share * 100)}% hidden along its ${name} side`)
    }
  }
  await state.evaluate(({ active, scrolls, page: [x, y] }) => {
    for (const n of document.querySelectorAll('*')) if (n.scrollTop || n.scrollLeft) { n.scrollTop = 0; n.scrollLeft = 0 }
    for (const [n, top, left] of scrolls) { n.scrollTop = top; n.scrollLeft = left }
    window.scrollTo({ left: x, top: y, behavior: 'instant' })
    if (active && active !== document.body) active.focus({ preventScroll: true })
    else document.activeElement?.blur()
  })
  return out
}

// Lines that end in the air (CONTRIBUTING.md, "Nothing is cut off"): a row whose cells draw
// column lines must be closed by a line under it, its own bottom border, the next row's top
// border, or the edge of a bordered box it ends on. Returns one line per open row.
export async function danglingLines(page, scope = page.locator('body')) {
  return scope.evaluate((root) => {
    if (root === document.body) {
      const open = (sel) => [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden')
      root = open('[data-popover], [role="menu"], [role="listbox"]').pop() || open('[aria-modal="true"]').pop() || root
    }
    const drawn = (s, side) => {
      const w = parseFloat(s[`border${side}Width`]) || 0
      const c = s[`border${side}Color`].match(/[\d.]+/g)?.map(Number) || []
      return w > 0 && s[`border${side}Style`] !== 'none' && s[`border${side}Style`] !== 'hidden' && (c.length < 4 || c[3] > 0)
    }
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    const out = []
    for (const row of root.querySelectorAll('*')) {
      if (!shown(row)) continue
      const kids = [...row.children].filter(shown)
      const r = row.getBoundingClientRect()
      if (r.height < 20) continue
      // A column line is a left border on its own, as tall as the row; a bordered box is not one.
      const line = (k) => {
        const s = getComputedStyle(k)
        return drawn(s, 'Left') && !drawn(s, 'Top') && !drawn(s, 'Right') && !drawn(s, 'Bottom') && k.getBoundingClientRect().height >= r.height - 2
      }
      if (!kids.some(line)) continue
      if (drawn(getComputedStyle(row), 'Bottom')) continue
      let next = row.nextElementSibling
      while (next && !shown(next)) next = next.nextElementSibling
      if (next && Math.abs(next.getBoundingClientRect().top - r.bottom) <= 1.5 && drawn(getComputedStyle(next), 'Top')) continue
      let closed = false
      for (let a = row.parentElement; a && a !== document.body && !closed; a = a.parentElement) {
        const b = a.getBoundingClientRect()
        if (Math.abs(b.bottom - r.bottom) > 1.5) break
        closed = drawn(getComputedStyle(a), 'Bottom')
        if (!closed && a.nextElementSibling && shown(a.nextElementSibling)) {
          const n = a.nextElementSibling
          closed = Math.abs(n.getBoundingClientRect().top - b.bottom) <= 1.5 && drawn(getComputedStyle(n), 'Top')
        }
      }
      if (closed) continue
      const label = row.getAttribute('aria-label') || (row.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
      out.push(`the column lines of the row "${label}" end with no line under it`)
    }
    return out
  })
}

// Long names everywhere, without touching the shared database: every GET under /api has its
// names lengthened on the way to the page (the same route trick the digest shots use). A name
// keeps its own start, so a test can still find it with a regular expression, and gains
// ordinary words and one long unbroken word, the two ways a real name outgrows its box.
export const LONG_SUFFIX = ' with a much longer name than anyone plans for Unbrokenwordthatkeepsgoingwithoutanyplacetobreak'
const LONG_KEYS = new Set(['title', 'name', 'assignee', 'description'])
const LONG_SKIP = new Set(['/api/events', '/api/health', '/api/update', '/api/identity', '/api/sync'])
export async function longNames(page) {
  const lengthen = (value) => {
    if (Array.isArray(value)) return value.forEach(lengthen)
    if (!value || typeof value !== 'object') return
    for (const [key, v] of Object.entries(value)) {
      if (LONG_KEYS.has(key) && typeof v === 'string' && v.trim()) value[key] = v + LONG_SUFFIX
      else lengthen(v)
    }
  }
  await page.route(
    (url) => url.pathname.startsWith('/api/') && !LONG_SKIP.has(url.pathname),
    async (route) => {
      if (!isGet(route)) return route.fallback()
      // A request a view started can still be in here when its test ends (the Goals view's
      // GitHub status, on CI): answering one that is gone is not a failure, so this is best
      // effort, as in delayRequest. An error thrown here belongs to no test and fails the run.
      try {
        const response = await route.fetch()
        if (!(response.headers()['content-type'] || '').includes('json')) return await route.fulfill({ response })
        const body = await response.json()
        lengthen(body)
        await route.fulfill({ response, json: body })
      } catch {
        // gone
      }
    }
  )
}

// The seeded Board cards with what a card can carry and the seed leaves off: due dates (today,
// tomorrow, overdue, later in the week), a repeat, and an assignee, for a shot or a check that
// needs to see them. The project's answer is rewritten on its way to the page, as longNames does,
// so the shared seeded project is never changed. Days count from the browser's frozen clock.
export async function boardCardExtras(page) {
  const now = await page.evaluate(() => Date.now()).catch(() => Date.now())
  const day = (n) => {
    const d = new Date(now)
    d.setDate(d.getDate() + n)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const extras = {
    'Board card alpha': { dueAt: day(0), assignee: 'Sam Rivera' },
    'Board card beta': { dueAt: day(1) },
    'Board card gamma': { dueAt: day(-2), recurrence: 'FREQ=WEEKLY;BYDAY=MO' },
    'Board milestone delta': { dueAt: day(4), assignee: 'Alex Chen' },
  }
  await page.route(
    (url) => /^\/api\/projects\/[^/]+$/.test(url.pathname),
    async (route) => {
      if (!isGet(route)) return route.fallback()
      try {
        const response = await route.fetch()
        const body = await response.json()
        for (const task of body.tasks || []) Object.assign(task, extras[task.title] || {})
        await route.fulfill({ response, json: body })
      } catch {
        // gone
      }
    }
  )
}
