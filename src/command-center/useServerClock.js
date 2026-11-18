import { useMemo, useSyncExternalStore } from 'react'
import { serverClockVersion, storedOffset, subscribeServerClock } from './serverClock'

// The stored reading of the server's clock for `origin`, re-read when the stored data changes.
// storedOffset parses localStorage on every call, so it is never the snapshot itself.
export function useServerClock(origin) {
  const version = useSyncExternalStore(subscribeServerClock, serverClockVersion, serverClockVersion)
  return useMemo(() => storedOffset(origin), [origin, version])
}
