import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { CLOCK_WARN_MS, correctedTimes, describeOffset, lastSentAt, measureServerTime, noteSent, noteServerTime, resetServerClock, serverClockVersion, storedOffset, subscribeServerClock } from './serverClock'

const MIN = 60 * 1000
const iso = (ms) => new Date(ms).toISOString()
const T = Date.parse('2026-11-17T12:00:00.000Z')

beforeEach(() => {
  localStorage.clear()
  resetServerClock()
})
afterEach(() => vi.restoreAllMocks())

describe('noteServerTime', () => {
  test('stores the offset from the midpoint of the request', () => {
    noteServerTime('http://x', iso(T + 10 * MIN + 50), T, T + 100)
    expect(storedOffset('http://x')).toEqual({ offsetMs: 10 * MIN, rttMs: 100, measuredAt: T + 100 })
  })

  test('a shorter or equal round trip replaces the sample, a longer one does not', () => {
    // Every reading here says the same thing about the clocks (the server is 950 ms ahead), so
    // only the round trip decides.
    noteServerTime('http://x', iso(T + 1000), T, T + 100)
    noteServerTime('http://x', iso(T + 2150), T + 1000, T + 1400)
    expect(storedOffset('http://x').rttMs).toBe(100)
    noteServerTime('http://x', iso(T + 2970), T + 2000, T + 2040)
    expect(storedOffset('http://x').rttMs).toBe(40)
    noteServerTime('http://x', iso(T + 3970), T + 3000, T + 3040)
    expect(storedOffset('http://x').measuredAt).toBe(T + 3040)
  })

  test('a reading that cannot agree with the stored one replaces it, even with a longer round trip', () => {
    // Stored: the server is 950 ms ahead, give or take 50. A minute later, with a round trip of
    // 400 ms, the server reads 3 minutes ahead: the device clock was changed in between.
    noteServerTime('http://x', iso(T + 1000), T, T + 100)
    noteServerTime('http://x', iso(T + MIN + 200 + 3 * MIN), T + MIN, T + MIN + 400)
    expect(storedOffset('http://x')).toEqual({ offsetMs: 3 * MIN, rttMs: 400, measuredAt: T + MIN + 400 })
    // A slow reading that still agrees, within what the two round trips allow, does not replace.
    noteServerTime('http://x', iso(T + 2 * MIN + 3 * MIN + 1000 + 300), T + 2 * MIN, T + 2 * MIN + 2000)
    expect(storedOffset('http://x').rttMs).toBe(400)
  })

  test('a sample more than five minutes from the new reading is replaced, in either direction', () => {
    noteServerTime('http://x', iso(T), T, T + 10)
    noteServerTime('http://x', iso(T + 6 * MIN), T + 6 * MIN, T + 6 * MIN + 500)
    expect(storedOffset('http://x').rttMs).toBe(500)
    // The device clock moved back: the stored reading is now "ahead" of this one.
    noteServerTime('http://x', iso(T), T, T + 900)
    expect(storedOffset('http://x').rttMs).toBe(900)
  })

  test('garbage is ignored', () => {
    noteServerTime('http://x', 'not a time', T, T + 10)
    noteServerTime('http://x', undefined, T, T + 10)
    noteServerTime('http://x', iso(T), T + 10, T)
    noteServerTime('http://x', iso(T), NaN, T)
    expect(storedOffset('http://x')).toBeNull()
  })

  test('each origin has its own sample', () => {
    noteServerTime('http://x', iso(T + MIN), T, T)
    noteServerTime('http://y', iso(T - MIN), T, T)
    expect(storedOffset('http://x').offsetMs).toBe(MIN)
    expect(storedOffset('http://y').offsetMs).toBe(-MIN)
    expect(storedOffset('http://z')).toBeNull()
  })

  test('a sample and a floor do not erase each other', () => {
    noteServerTime('http://x', iso(T + MIN), T, T)
    noteSent('http://x', T + 5)
    expect(storedOffset('http://x').offsetMs).toBe(MIN)
    noteServerTime('http://x', iso(T + 2 * MIN), T, T)
    expect(lastSentAt('http://x')).toBe(T + 5)
    expect(storedOffset('http://x').offsetMs).toBe(2 * MIN)
  })

  test('the floor only moves up', () => {
    noteSent('http://x', T + 5)
    noteSent('http://x', T)
    expect(lastSentAt('http://x')).toBe(T + 5)
    expect(lastSentAt('http://y')).toBeUndefined()
  })

  test('still works, for the life of the page, when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    noteServerTime('http://x', iso(T + MIN), T, T)
    noteSent('http://x', T + 9)
    expect(storedOffset('http://x').offsetMs).toBe(MIN)
    expect(lastSentAt('http://x')).toBe(T + 9)
  })
})

describe('storage that reads but cannot be written', () => {
  test('a reading and a floor are still kept for the life of the page', () => {
    // A private window or a full disk: getItem answers (with nothing), setItem throws.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    noteServerTime('http://x', iso(T + MIN), T, T)
    noteSent('http://x', T + 9)
    expect(storedOffset('http://x').offsetMs).toBe(MIN)
    expect(lastSentAt('http://x')).toBe(T + 9)
    noteSent('http://x', T + 20)
    expect(lastSentAt('http://x')).toBe(T + 20)
    expect(storedOffset('http://x').offsetMs).toBe(MIN)
  })
})

describe('storedOffset with an age limit', () => {
  test('a sample further than the limit from now, in either direction, is not given', () => {
    noteServerTime('http://x', iso(T + MIN), T, T)
    expect(storedOffset('http://x', { maxAgeMs: 60 * MIN, now: T + 59 * MIN }).offsetMs).toBe(MIN)
    expect(storedOffset('http://x', { maxAgeMs: 60 * MIN, now: T + 61 * MIN })).toBeNull()
    expect(storedOffset('http://x', { maxAgeMs: 60 * MIN, now: T - 61 * MIN })).toBeNull()
    expect(storedOffset('http://x').offsetMs).toBe(MIN)
  })
})

describe('measureServerTime', () => {
  test('an answer that arrives after the limit is not kept', async () => {
    vi.useFakeTimers()
    try {
      let answer
      const fetchImpl = () => new Promise((resolve) => { answer = resolve })
      const pending = measureServerTime('http://x', 't', { fetchImpl, timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1001)
      expect(await pending).toBeNull()
      answer({ ok: true, json: async () => ({ now: iso(T) }) })
      await vi.advanceTimersByTimeAsync(10)
      expect(storedOffset('http://x')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  const answer = (body, ok = true) => vi.fn(async () => ({ ok, json: async () => body }))

  test('reads GET /api/events?limit=1 with the token, uncached, and stores the sample', async () => {
    const fetchImpl = answer({ now: iso(T + 10 * MIN + 5) })
    const clock = [T, T + 10]
    const sample = await measureServerTime('http://x', 'tok', { fetchImpl, now: () => clock.shift() })
    expect(sample).toEqual({ offsetMs: 10 * MIN, rttMs: 10, measuredAt: T + 10 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/events?limit=1')
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(storedOffset('http://x')).toEqual(sample)
  })

  test('resolves to null, and never throws, on an error, a refusal, or an answer with no time', async () => {
    expect(await measureServerTime('http://x', 't', { fetchImpl: vi.fn(async () => { throw new Error('down') }) })).toBeNull()
    expect(await measureServerTime('http://x', 't', { fetchImpl: answer({ now: iso(T) }, false) })).toBeNull()
    expect(await measureServerTime('http://x', 't', { fetchImpl: answer({ events: [] }) })).toBeNull()
    expect(await measureServerTime('http://x', 't', { fetchImpl: vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json') } })) })).toBeNull()
    expect(storedOffset('http://x')).toBeNull()
  })

  test('gives up after the timeout', async () => {
    vi.useFakeTimers()
    try {
      const pending = measureServerTime('http://x', 't', { fetchImpl: () => new Promise(() => {}), timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1001)
      expect(await pending).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('correctedTimes', () => {
  const entry = (at) => ['k', { at }]

  test('a device ten minutes behind: 11:55 with +10 minutes is 12:05', () => {
    const out = correctedTimes([entry('2026-11-17T11:55:00.000Z')], { offsetMs: 10 * MIN, now: T })
    expect(out).toEqual(['2026-11-17T12:05:00.000Z'])
  })

  test('a device ten minutes ahead: 12:15 with -10 minutes is 12:05', () => {
    const out = correctedTimes([entry('2026-11-17T12:15:00.000Z')], { offsetMs: -10 * MIN, now: T })
    expect(out).toEqual(['2026-11-17T12:05:00.000Z'])
  })

  test('no offset leaves the readings, and backwards readings still rise', () => {
    const out = correctedTimes([entry(iso(T)), entry(iso(T - 5000)), entry(iso(T))], { now: T + 1e6 })
    expect(out).toEqual([iso(T), iso(T + 1), iso(T + 2)])
  })

  test('starts above the floor', () => {
    const out = correctedTimes([entry(iso(T - 5000))], { floorMs: T, now: T + 1e6 })
    expect(out).toEqual([iso(T + 1)])
  })

  test('a floor above the estimated now is capped at it', () => {
    // now + offset is T + 10 minutes, so a floor of T + 99 minutes counts as T + 10 minutes.
    const out = correctedTimes([entry(iso(T - 5000))], { offsetMs: 10 * MIN, floorMs: T + 99 * MIN, now: T })
    expect(out).toEqual([iso(T + 10 * MIN + 1)])
  })

  test('a corrected time no Date can hold passes the reading through, and nothing throws', () => {
    const out = correctedTimes([entry(iso(T)), entry(iso(T + 1000))], { offsetMs: 9e15, now: T })
    expect(out).toEqual([iso(T), iso(T + 1000)])
  })

  test('a time that does not parse passes through and does not move the running value', () => {
    const out = correctedTimes([entry(iso(T)), entry('garbage'), entry(iso(T - 1000))], { now: T + 1e6 })
    expect(out).toEqual([iso(T), 'garbage', iso(T + 1)])
  })
})

describe('describeOffset', () => {
  const SEC = 1000
  const HOUR = 60 * MIN
  const at = (offsetMs, rttMs = 100) => describeOffset({ offsetMs, rttMs, measuredAt: T })

  test('no reading, or an invalid one, is none', () => {
    const none = { state: 'none', amount: null, warn: false }
    expect(describeOffset(null)).toEqual(none)
    expect(describeOffset(undefined)).toEqual(none)
    expect(describeOffset({ offsetMs: 'x', rttMs: 1, measuredAt: 1 })).toEqual(none)
  })

  test('a difference inside one second or half the round trip is a match', () => {
    const match = { state: 'match', amount: null, warn: false }
    expect(at(1000)).toEqual(match)
    expect(at(-1000)).toEqual(match)
    expect(at(0)).toEqual(match)
    expect(at(2500, 5000)).toEqual(match)
    expect(at(2501, 5000).state).toBe('behind')
  })

  test('amounts are in whole seconds, minutes, hours or days, singular for one', () => {
    expect(at(1400)).toEqual({ state: 'behind', amount: '1 second', warn: false })
    expect(at(42 * SEC).amount).toBe('42 seconds')
    expect(at(89 * SEC).amount).toBe('89 seconds')
    expect(at(90 * SEC).amount).toBe('2 minutes')
    expect(at(10 * MIN).amount).toBe('10 minutes')
    expect(at(90 * MIN).amount).toBe('2 hours')
    expect(at(36 * HOUR).amount).toBe('2 days')
    expect(at(3 * 24 * HOUR).amount).toBe('3 days')
    expect(at(60 * MIN).amount).toBe('60 minutes')
  })

  test('the sign says behind or ahead', () => {
    expect(at(10 * MIN).state).toBe('behind')
    expect(at(-10 * MIN).state).toBe('ahead')
    expect(at(-10 * MIN).amount).toBe('10 minutes')
  })

  test('the warning starts at thirty seconds', () => {
    expect(CLOCK_WARN_MS).toBe(30 * SEC)
    expect(at(29.9 * SEC).warn).toBe(false)
    expect(at(30 * SEC).warn).toBe(true)
    expect(at(-30 * SEC).warn).toBe(true)
  })
})

describe('subscribeServerClock', () => {
  test('is told when a reading, a sent time or a reset changes the stored data', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeServerClock(listener)
    const before = serverClockVersion()
    noteServerTime('http://x', iso(T + 1000), T, T + 100)
    expect(listener).toHaveBeenCalledTimes(1)
    noteSent('http://x', T)
    expect(listener).toHaveBeenCalledTimes(2)
    resetServerClock()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(serverClockVersion()).toBe(before + 3)
    unsubscribe()
    noteServerTime('http://x', iso(T + 1000), T, T + 100)
    resetServerClock()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  test('another tab writing the key is a change too', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeServerClock(listener)
    window.dispatchEvent(new StorageEvent('storage', { key: 'cc-server-clock-v1' }))
    expect(listener).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})
