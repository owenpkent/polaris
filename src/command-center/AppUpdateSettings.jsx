import { useEffect, useState } from 'react'
import { ErrorBanner } from './shared'
import { isNativeApp, getAppInfo } from './nativeApp'
import { checkForAppUpdate, RELEASES_PAGE } from './appUpdate'

function Row({ label, children }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

const ROW_STYLE = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }

// Checks the newest GitHub release on demand, Android app only. Nothing is asked until the owner
// presses the button, and nothing is installed here: the APK link opens in the browser.
export default function AppUpdateSettings() {
  const native = isNativeApp()
  const [version, setVersion] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!native) return undefined
    let live = true
    getAppInfo().then(
      (info) => { if (live) { setVersion(info?.version || null); setLoaded(true) } },
      () => { if (live) setLoaded(true) },
    )
    return () => { live = false }
  }, [native])

  if (!native) return null

  async function check() {
    setChecking(true)
    setError(null)
    setResult(null)
    try {
      setResult(await checkForAppUpdate(version))
    } catch (e) {
      setError(e)
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="card" aria-labelledby="cc-app-update-heading">
      <div className="section-header" id="cc-app-update-heading">App update</div>

      <dl className="settings-facts">
        <Row label="This app">{version ? `v${version}` : loaded ? 'Unknown' : 'Checking'}</Row>
      </dl>

      <div style={{ ...ROW_STYLE, marginTop: '0.75rem' }}>
        <button type="button" className="btn" disabled={checking} onClick={check}>
          Check for updates
        </button>
      </div>

      <div aria-live="polite">
        {result?.state === 'newer' && (
          <div style={{ ...ROW_STYLE, marginTop: '0.75rem' }}>
            <span>v{result.latest} is available.</span>
            <a className="btn" href={result.apk.url} target="_blank" rel="noopener noreferrer">
              Download {result.apk.name}
            </a>
          </div>
        )}
        {result?.state === 'no-apk' && (
          <div style={{ ...ROW_STYLE, marginTop: '0.75rem' }}>
            <span>v{result.latest} has no APK attached.</span>
            <a className="btn" href={RELEASES_PAGE} target="_blank" rel="noopener noreferrer">
              Releases page
            </a>
          </div>
        )}
        {result?.state === 'current' && (
          <p style={{ marginTop: '0.75rem' }}>You have the newest version.</p>
        )}
        {result?.state === 'unknown' && (
          <p style={{ marginTop: '0.75rem' }}>The newest release has no version.</p>
        )}
        {error && (
          <div style={{ marginTop: '0.75rem' }}>
            <ErrorBanner message={error.message} />
          </div>
        )}
      </div>

      <p style={{ fontSize: '0.8rem', color: 'var(--t2)', marginTop: '0.75rem', marginBottom: 0 }}>
        Asks GitHub for the newest release only when you press the button. The download opens in the browser, and Android installs it over this app when it is signed with the same certificate.
      </p>
    </section>
  )
}
