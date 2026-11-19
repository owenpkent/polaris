import { useMemo, useSyncExternalStore } from 'react'
import { lastCheckedAt, serverClockVersion, storedOffset, subscribeServerClock } from './serverClock'

// What is stored about the server's clock for `origin`, re-read when the stored data changes:
// `reading` is the stored sample (or null) and `checkedAt` the device time of the last reading
// taken, which is later than the sample's own time when a newer reading only confirmed it.
// storedOffset parses localStorage on every call, so it is never the snapshot itself.
export function useServerClock(origin) {
  const version = useSyncExternalStore(subscribeServerClock, serverClockVersion, serverClockVersion)
  return useMemo(() => ({ reading: storedOffset(origin), checkedAt: lastCheckedAt(origin) }), [origin, version])
}
