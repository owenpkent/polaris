import { useConnection } from './ConnectionContext'
import { BUILD_INFO } from './buildInfo'

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 0.75rem', fontSize: '0.85rem', padding: '0.3rem 0' }}>
      <span style={{ color: 'var(--t2)', flex: '0 0 7.5rem' }}>{label}</span>
      <span style={{ flex: '1 1 12rem', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
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

// Which code is running: the dashboard's build, and the server's version as its last health
// check reported it. Nothing here asks the server anything, so it reads the same offline.
export default function AboutSettings({ build = BUILD_INFO }) {
  const { connected, health } = useConnection()
  const server = health?.version ? `v${health.version}` : connected ? 'Not reached yet' : 'Not connected'
  return (
    <section className="card" aria-labelledby="cc-about-heading">
      <div className="section-header" id="cc-about-heading">About</div>
      <Row label="Dashboard">{formatBuild(build)}</Row>
      <Row label="Server">{server}</Row>
    </section>
  )
}
