import { describe, test, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// public/sw.js is a plain worker script, so it is run here against a stand-in for the worker
// globals: `self` collects its listeners, `caches` is one in-memory cache, and `fetch` is the
// network each test sets up.

const SOURCE = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8')
const ORIGIN = 'http://cc.test'

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, body, clone() { return this } }
}

let stored
let network
let listeners

function load() {
  stored = new Map()
  listeners = {}
  const keyOf = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname
  const cache = {
    put: async (req, res) => { stored.set(keyOf(req), res) },
    match: async (req) => stored.get(keyOf(req)),
    add: async () => {},
  }
  const caches = { open: async () => cache, match: cache.match, keys: async () => [], delete: async () => true }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  }
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, (req) => network(req))
}

// Sends a page load through the worker's fetch handler and resolves to what the page would get.
function navigateTo(path) {
  let answer
  listeners.fetch({
    request: { url: `${ORIGIN}${path}`, method: 'GET', mode: 'navigate' },
    respondWith: (p) => { answer = p },
  })
  return answer
}

beforeEach(load)

describe('service worker: opening the dashboard', () => {
  test.each([502, 503, 504])('a %i from the proxy in front of a stopped daemon opens the stored page', async (status) => {
    network = async () => response(200, 'dashboard')
    await navigateTo('/')

    network = async () => response(status, 'gateway error page')
    expect((await navigateTo('/?view=board')).body).toBe('dashboard')
    // The error page was not kept in place of the dashboard.
    expect(stored.get('/').body).toBe('dashboard')

    network = async () => response(200, 'new build')
    expect((await navigateTo('/')).body).toBe('new build')
    expect(stored.get('/').body).toBe('new build')
  })

  test('a gateway error with nothing stored is passed on as it is', async () => {
    network = async () => response(502, 'gateway error page')
    const res = await navigateTo('/')
    expect(res.status).toBe(502)
    expect(stored.size).toBe(0)
  })

  test('a failed fetch still opens the stored page', async () => {
    network = async () => response(200, 'dashboard')
    await navigateTo('/')
    network = async () => { throw new TypeError('Failed to fetch') }
    expect((await navigateTo('/')).body).toBe('dashboard')
  })

  test('any other error status is the server\'s own answer and is shown', async () => {
    network = async () => response(200, 'dashboard')
    await navigateTo('/')
    network = async () => response(500, 'server error')
    expect((await navigateTo('/')).status).toBe(500)
  })
})
