// A tab left open in the background keeps running the build it loaded, so after an update it shows
// the old dashboard until the owner reloads it. While the tab is hidden, this asks the server
// which build it serves now and, when that has changed, reloads the tab so it is current by the
// time the owner comes back. A visible tab is never reloaded under the owner.
//
// The build is named by the hashed entry script in index.html (/assets/index-<hash>.js), so
// nothing on the server has to change. The check goes to the network only: a server that cannot
// be reached, or a proxy's gateway error, is no answer, and the tab is left as it is.
//
// The reload waits while anything could be lost: an open dialog or panel, a text field holding
// text, or a write still out (writesPending in api.js) or a control still marked aria-busy while
// the page takes in its answer, such as a new task's name box between Enter and the save. Edits queued offline are kept in IndexedDB by outbox.js and survive a reload, and the view
// is in the URL (?view=), so the tab comes back where it was.

import { isTextEntry } from './keyboard'
import { writesPending } from './command-center/api'

export const CHECK_INTERVAL_MS = 5 * 60 * 1000
// Remembers the build this tab last reloaded for, so a server that keeps naming a build the tab
// cannot load does not reload it over and over.
const RELOADED_FOR_KEY = 'cc-reloaded-for-build'

const ENTRY_PATTERN = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']*\/assets\/[^"']+\.js)["']/i

// The entry script named in an index.html, as a path, or null.
export function entryFromHtml(html) {
  const match = ENTRY_PATTERN.exec(html || '')
  if (!match) return null
  try {
    return new URL(match[1], 'http://x').pathname
  } catch {
    return null
  }
}

// The entry script this page was loaded with, as a path, or null.
export function currentEntry(doc = document) {
  for (const script of doc.querySelectorAll('script[type="module"][src]')) {
    const path = new URL(script.src, doc.baseURI).pathname
    if (path.startsWith('/assets/')) return path
  }
  return null
}

// Whether a reload now could throw away something the owner is in the middle of.
export function busy(doc = document) {
  if (doc.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')) return true
  if (writesPending() || doc.querySelector('[aria-busy="true"]')) return true
  for (const el of doc.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable="true"]')) {
    if (!isTextEntry(el)) continue
    if (el.isContentEditable ? el.textContent.trim() : el.value) return true
  }
  return false
}

// The service worker sends this straight to the network and never stores it (public/sw.js,
// BUILD_PROBE_PARAM), so the stored offline page stays the one whose scripts are stored with it.
// A worker from before that rule would store it under this URL, not '/', which is just as safe.
export const BUILD_PROBE_URL = '/?cc-build-probe=1'

async function servedEntry(fetchImpl) {
  const response = await fetchImpl(BUILD_PROBE_URL, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) return null
  return entryFromHtml(await response.text())
}

// Starts watching and returns a function that stops it.
export function watchForNewBuild({
  win = window,
  fetchImpl = (...args) => win.fetch(...args),
  reload = () => win.location.reload(),
  intervalMs = CHECK_INTERVAL_MS,
} = {}) {
  const doc = win.document
  const running = currentEntry(doc)
  if (!running) return () => {}
  let timer = null
  let stopped = false

  async function check() {
    timer = null
    if (stopped || !doc.hidden) return
    try {
      const served = await servedEntry(fetchImpl)
      if (stopped || !doc.hidden) return
      if (served && served !== running && !busy(doc)) {
        let last = null
        try { last = win.sessionStorage.getItem(RELOADED_FOR_KEY) } catch { /* storage blocked */ }
        if (last !== served) {
          try { win.sessionStorage.setItem(RELOADED_FOR_KEY, served) } catch { /* storage blocked */ }
          reload()
          return
        }
      }
    } catch {
      // The server is away or answered oddly; the next check tries again.
    }
    if (!stopped && doc.hidden) timer = win.setTimeout(check, intervalMs)
  }

  function onVisibility() {
    win.clearTimeout(timer)
    timer = null
    if (doc.hidden) check()
  }

  doc.addEventListener('visibilitychange', onVisibility)
  if (doc.hidden) check()
  return () => {
    stopped = true
    win.clearTimeout(timer)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
