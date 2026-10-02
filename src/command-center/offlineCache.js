// The local copy of the Command Center data: every GET response, kept in IndexedDB under its
// full URL, so api.js can answer from it when the server cannot be reached. Storing responses
// rather than rows means a view reads exactly the shape it reads online, and nothing the server
// derives (view filters, goal progress) has to be rebuilt in the browser.
//
// Every function resolves rather than rejects. The cache is a convenience: a private window, a
// full disk, or a browser with no IndexedDB must leave the dashboard working as it did before.

const DB_NAME = 'cc-offline-v1'
const STORE = 'responses'

function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function indexedDbBackend(name = DB_NAME) {
  let dbPromise = null
  const run = async (mode, work) => {
    if (!dbPromise) dbPromise = openDb(name)
    const db = await dbPromise
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = work(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req?.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: (key, value) => run('readwrite', (s) => s.put(value, key)),
    delete: (key) => run('readwrite', (s) => s.delete(key)),
    clear: () => run('readwrite', (s) => s.clear()),
    // The read and the write share one readwrite transaction, which IndexedDB runs alone on the
    // store: another tab cannot change or delete the entry between them.
    update: async (key, decide) => {
      if (!dbPromise) dbPromise = openDb(name)
      const db = await dbPromise
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        let written = false
        const read = store.get(key)
        read.onsuccess = () => {
          const next = decide(read.result)
          if (next === undefined) return
          store.put(next, key)
          written = true
        }
        tx.oncomplete = () => resolve(written)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    },
    // Keys and values come from two requests in one transaction, so they line up.
    entries: async () => {
      if (!dbPromise) dbPromise = openDb(name)
      const db = await dbPromise
      return new Promise((resolve, reject) => {
        const store = db.transaction(STORE, 'readonly').objectStore(STORE)
        const keys = store.getAllKeys()
        const values = store.getAll()
        values.onsuccess = () => resolve(keys.result.map((key, i) => [key, values.result[i]]))
        values.onerror = () => reject(values.error)
      })
    },
  }
}

// Every backend has get, put, delete, clear, entries, and update. `update(key, decide)` reads the
// entry, hands it (undefined when there is none) to `decide`, and writes what that returns, all
// in one step: returning undefined leaves the entry alone. It resolves to whether it wrote.

/** An in-memory stand-in, for tests and for browsers with no IndexedDB. */
export function memoryBackend() {
  const map = new Map()
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => { map.set(key, value) },
    delete: async (key) => { map.delete(key) },
    clear: async () => { map.clear() },
    // Nothing awaits between the read and the write, so it is as atomic as the IndexedDB one.
    update: async (key, decide) => {
      const next = decide(map.get(key))
      if (next === undefined) return false
      map.set(key, next)
      return true
    },
    entries: async () => [...map.entries()],
  }
}

let backend = null

function getBackend() {
  if (!backend) backend = typeof indexedDB === 'undefined' ? memoryBackend() : indexedDbBackend()
  return backend
}

export function setCacheBackend(next) {
  backend = next
}

export async function cachePut(key, data, now = Date.now()) {
  try {
    await getBackend().put(key, { data, savedAt: now })
  } catch {
    // Not cached. The response still reaches the caller.
  }
}

/** `{ data, savedAt }`, or null when there is no copy of this response. */
export async function cacheGet(key) {
  try {
    return (await getBackend().get(key)) || null
  } catch {
    return null
  }
}

export async function cacheClear() {
  try {
    await getBackend().clear()
  } catch {
    // Nothing to clear, or nothing that can be cleared.
  }
}

/**
 * Rewrites every stored answer through `patch(data, key)`, which returns the new data or
 * undefined to leave that answer alone. This is how an edit made offline shows up in every view:
 * the copy is stored responses, so the task is changed wherever it appears in them.
 */
export async function cachePatchAll(patch) {
  try {
    const store = getBackend()
    for (const [key, entry] of await store.entries()) {
      const next = patch(entry.data, key)
      if (next !== undefined) await store.put(key, { ...entry, data: next })
    }
  } catch {
    // The edit is still in the outbox. Only its preview is missing.
  }
}
