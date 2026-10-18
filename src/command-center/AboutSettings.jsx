import { useEffect, useState } from 'react'
import { useConnection } from './ConnectionContext'
import { BUILD_INFO } from './buildInfo'

function Row({ label, children }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export function formatBuild({ version, commit, builtAt } = BUILD_INFO) {
  if (!version) return 'Unknown'
  const parts = [`v${version}`]
  if (commit) parts.push(commit)
  if (builtAt) parts.push(`built ${new Date(builtAt).toLocaleString()}`)
  return parts.join(' · ')
}

// Which code is running: the dashboard's build, and the server's version. The card asks the
// server once when it opens, so a server updated since the connection test shows its new
// version. /api/health is never cached, so offline that ask fails and the card keeps the
// version the last health check reported.
export default function AboutSettings({ build = BUILD_INFO }) {
  const { connected, health, api } = useConnection()
  const [fresh, setFresh] = useState(null)
  useEffect(() => {
    // A different server, or none, starts from its own health check, never the last one's answer.
    setFresh(null)
    if (!connected) return undefined
    let live = true
    api.health().then((res) => { if (live && res?.version) setFresh(res.version) }, () => {})
    return () => { live = false }
  }, [connected, api])
  const version = (connected && fresh) || health?.version
  const server = version ? `v${version}` : connected ? 'Not reached yet' : 'Not connected'
  return (
    <section className="card" aria-labelledby="cc-about-heading">
      <div className="section-header" id="cc-about-heading">About</div>
      <dl className="settings-facts">
        <Row label="Dashboard">{formatBuild(build)}</Row>
        <Row label="Server">{server}</Row>
      </dl>
    </section>
  )
}
