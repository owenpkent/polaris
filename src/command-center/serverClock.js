// What this device knows about the server's clock, per server (origin).
//
// A queued edit is stamped with the device's own clock when it is made (outbox.js). The server
// merges two edits to one field by their times (command-center/src/core/outbox.ts), so a device
// whose clock is wrong would win or lose conflicts it should not. At send time the dashboard
// measures the offset between the two clocks and sends each edit's time in the server's time.
// Order is not decided here: the queue keeps its own counter.
//
// The stored object is one JSON value in localStorage, keyed by origin:
//   { [origin]: { sample: { offsetMs, rttMs, measuredAt } | null, floorMs: number | null } }
// `sample` is the best recent measurement. `floorMs` is the last time sent to that server, so a
// later flush never starts below it.

const KEY = 'cc-server-clock-v1'
const MAX_SAMPLE_AGE_MS = 5 * 60 * 1000
// Two readings a few minutes apart also differ by what the clocks drifted, which is far below this.
const DISAGREE_SLACK_MS = 50
// The range a Date can hold. A time outside it cannot be written as ISO.
const MAX_DATE_MS = 8.64e15

// The copy that serves, until the page closes, when storage cannot be written (denied, full, a
// private window). Reading may still work then, and would give back what was there before the
// write failed, so once a write has failed this copy is the one that counts.
let memory = {}
let unsaved = false

function load() {
  if (unsaved) return memory
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return {}
  } catch {
    return memory
  }
}

function save(all) {
  memory = all
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
    unsaved = false
  } catch {
    unsaved = true
  }
}

/** Forgets everything, stored or not. For tests. */
export function resetServerClock() {
  memory = {}
  unsaved = false
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing stored that can be removed.
  }
}

function entryFor(all, origin) {
  const e = all[origin]
  return e && typeof e === 'object' ? e : { sample: null, floorMs: null }
}

function validSample(s) {
  return s && Number.isFinite(s.offsetMs) && Number.isFinite(s.rttMs) && Number.isFinite(s.measuredAt)
}

/**
 * Records one reading of the server's clock. `t0` and `t1` are the device's clock (ms) before and
 * after the request that returned `serverNowIso`. Resolves to nothing; garbage is ignored. The
 * stored sample is replaced when the new one had a shorter or equal round trip, when the stored
 * one is more than five minutes from `t1` in either direction (the device's clock may have moved),
 * or when the two cannot both be right: each is off by at most half its round trip, so offsets
 * further apart than that mean one of the clocks was changed in between, and the newer one counts.
 */
export function noteServerTime(origin, serverNowIso, t0, t1) {
  if (typeof serverNowIso !== 'string') return null
  const serverMs = Date.parse(serverNowIso)
  if (!Number.isFinite(serverMs) || !Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return null
  const sample = { offsetMs: Math.round(serverMs - (t0 + t1) / 2), rttMs: t1 - t0, measuredAt: t1 }
  const all = { ...load() }
  const entry = entryFor(all, origin)
  const old = entry.sample
  const disagree = validSample(old) && Math.abs(sample.offsetMs - old.offsetMs) > (sample.rttMs + old.rttMs) / 2 + DISAGREE_SLACK_MS
  if (!validSample(old) || disagree || sample.rttMs <= old.rttMs || Math.abs(t1 - old.measuredAt) > MAX_SAMPLE_AGE_MS) {
    all[origin] = { ...entry, sample }
    save(all)
  }
  return sample
}

/**
 * The stored sample for `origin`, or null. With `maxAgeMs`, null as well when the sample was
 * taken more than that from `now` in either direction: an old reading says little about a clock
 * that may have been corrected since.
 */
export function storedOffset(origin, { maxAgeMs, now = Date.now() } = {}) {
  const s = entryFor(load(), origin).sample
  if (!validSample(s)) return null
  if (Number.isFinite(maxAgeMs) && Math.abs(now - s.measuredAt) > maxAgeMs) return null
  return s
}

/** The last time (ms, server time) sent to `origin`, or undefined. */
export function lastSentAt(origin) {
  const f = entryFor(load(), origin).floorMs
  return Number.isFinite(f) ? f : undefined
}

export function noteSent(origin, ms) {
  if (!Number.isFinite(ms)) return
  const all = { ...load() }
  const entry = entryFor(all, origin)
  if (Number.isFinite(entry.floorMs) && entry.floorMs >= ms) return
  all[origin] = { ...entry, floorMs: ms }
  save(all)
}

/**
 * One GET /api/events?limit=1 to read the server's clock. Resolves to the sample, or null on any
 * failure or timeout. Never throws.
 */
export async function measureServerTime(origin, token, { timeoutMs = 2500, fetchImpl = fetch, now = Date.now } = {}) {
  const controller = new AbortController()
  let timer
  let expired = false
  // The race also covers a fetch that ignores the abort signal.
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true
      controller.abort()
      resolve(null)
    }, timeoutMs)
  })
  const measured = (async () => {
    const t0 = now()
    const response = await fetchImpl(`${origin}/api/events?limit=1`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: controller.signal,
    })
    if (!response || !response.ok) return null
    const data = await response.json()
    // An answer that arrives after the limit was given up on is not a reading worth keeping.
    if (expired) return null
    const t1 = now()
    return noteServerTime(origin, data?.now, t0, t1)
  })().catch(() => null)
  try {
    return await Promise.race([measured, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The time to send for each of `entries` (sorted `[key, op]` pairs), in server time and strictly
 * rising in queue order. Pure. An op whose own `at` does not parse is passed through untouched and
 * does not move the running value, and so is one whose corrected time no Date can hold (sending
 * must never fail on a clock). A `floorMs` from an earlier flush is capped at the server's
 * estimated now, so a wrong floor cannot push every later edit into the future.
 */
export function correctedTimes(entries, { offsetMs, floorMs, now }) {
  const offset = Number.isFinite(offsetMs) ? offsetMs : 0
  let prev = Math.min(Number.isFinite(floorMs) ? floorMs : -Infinity, now + offset)
  return entries.map(([, op]) => {
    const raw = Date.parse(op?.at)
    if (Number.isNaN(raw)) return op?.at
    const t = Math.max(raw + offset, prev + 1)
    if (!(Math.abs(t) <= MAX_DATE_MS)) return op.at
    prev = t
    return new Date(t).toISOString()
  })
}
