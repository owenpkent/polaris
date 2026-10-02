// App shell cache, so the dashboard opens when the Command Center server cannot be reached.
// It never touches /api or /mcp: the local copy of the data is src/command-center/offlineCache.js,
// which knows which answers may be replayed. See initiatives/offline-clone.md.

// v2: the shell's headers changed (frame-ancestors), and a copy stored before that must not be served.
const CACHE = 'cc-shell-v2'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

function isShellRequest(request, url) {
  if (request.method !== 'GET' || url.origin !== self.location.origin) return false
  return !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/mcp')
}

// A proxy in front of a stopped daemon (tailscale serve) answers for it with one of these. For
// opening the dashboard they mean the same as no answer at all, as they do in api.js.
const GATEWAY_STATUSES = [502, 503, 504]

// The page from the network, or the stored one when the server is away. With nothing stored,
// the gateway's own answer is better than none.
async function navigate(request) {
  let response
  try {
    response = await fromNetwork(request, '/')
  } catch (err) {
    const stored = await caches.match('/')
    if (stored) return stored
    throw err
  }
  if (!GATEWAY_STATUSES.includes(response.status)) return response
  return (await caches.match('/')) || response
}

async function fromNetwork(request, cacheKey) {
  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(CACHE)
    await cache.put(cacheKey, response.clone())
  }
  return response
}

// The manifest and icons are fetched by the browser, not the page, so they are never in the
// page's resource list. They are stored with the shell so an installed app keeps its icon.
const INSTALL_FILES = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/logo.png']

// The first visit loads its files before this worker controls the page, so none of them pass
// through the fetch handler below. main.jsx sends the list once the worker is ready, so one
// visit is enough to open offline.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'precache' || !Array.isArray(event.data.urls)) return
  const urls = event.data.urls.filter((raw) => {
    try {
      return isShellRequest({ method: 'GET' }, new URL(raw, self.location.origin))
    } catch {
      return false
    }
  })
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(['/', ...INSTALL_FILES, ...urls].map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(() => {}))))
    )
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (!isShellRequest(event.request, url)) return

  // Every page load is the one index.html whatever ?view= it carries, so keep a single copy.
  // Network first, so a new build is picked up the moment the server is reachable.
  if (event.request.mode === 'navigate') {
    event.respondWith(navigate(event.request))
    return
  }

  // Built assets carry a content hash in their name, so a cached one never goes stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(event.request).then((hit) => hit || fromNetwork(event.request, event.request)))
    return
  }

  event.respondWith(fromNetwork(event.request, event.request).catch(() => caches.match(event.request)))
})
