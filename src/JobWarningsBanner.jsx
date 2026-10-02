import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { useConnection } from './command-center/ConnectionContext'
import { useOffline } from './command-center/offlineStatus'
import { Strip } from './OfflineBanner'

const REFRESH_MS = 5 * 60_000

// Shown under the top bar when the server says a job is failing or the database backup has gone
// quiet (`warnings` on GET /api/sync, built by http/warnings.ts). Hidden while offline: the answer
// would come from the copy saved on this device, and an old warning is worse than none.
export default function JobWarningsBanner() {
  const { connected, api } = useConnection()
  const offline = useOffline()
  const [warnings, setWarnings] = useState([])

  useEffect(() => {
    if (!connected || offline) return undefined
    let cancelled = false
    const load = () => api.getSync()
      .then((res) => { if (!cancelled) setWarnings(res?.warnings ?? []) })
      .catch(() => {})
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [connected, offline, api])

  if (!connected || offline || warnings.length === 0) return null

  return (
    <Strip tone="var(--red)" soft="var(--red-soft)" icon={AlertCircle}>
      <strong style={{ color: 'var(--red)' }}>Needs a look.</strong>{' '}
      {warnings.map((w) => w.message).join(' ')} The Digest tab has the details.
    </Strip>
  )
}
