import { useEffect, useState } from 'react'
import { ErrorBanner } from './shared'
import { isNativeApp, getAppInfo } from './nativeApp'
import { RELEASES_PAGE } from './appUpdate'
import {
  readAppUpdatePrefs, saveAppUpdatePrefs, runAppUpdateCheck, installReadyUpdate, APP_UPDATE_CHANGED_EVENT,
} from './appAutoUpdate'

function Row({ label, children }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

const ROW_STYLE = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }

function formatChecked(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// The app updates itself, Android app only: AppUpdateScheduler checks in the background and
// downloads a newer APK, and this card holds the choice, shows the result and starts the install.
// Android still asks the owner to confirm the install once.
export default function AppUpdateSettings() {
  const native = isNativeApp()
  const [version, setVersion] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [prefs, setPrefs] = useState(readAppUpdatePrefs)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [needsAllow, setNeedsAllow] = useState(false)
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

  useEffect(() => {
    const onChange = () => setPrefs(readAppUpdatePrefs())
    window.addEventListener(APP_UPDATE_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(APP_UPDATE_CHANGED_EVENT, onChange)
  }, [])

  if (!native) return null

  async function checkNow() {
    setChecking(true)
    setError(null)
    setNeedsAllow(false)
    try {
      await runAppUpdateCheck({ running: version, force: true })
    } catch (e) {
      setError(e)
    } finally {
      setPrefs(readAppUpdatePrefs())
      setChecking(false)
    }
  }

  async function install() {
    setInstalling(true)
    setError(null)
    try {
      const res = await installReadyUpdate()
      setNeedsAllow(res?.opened === 'settings')
    } catch (e) {
      setError(e)
    } finally {
      setInstalling(false)
    }
  }

  const checked = prefs.lastCheckedAt ? formatChecked(prefs.lastCheckedAt) : null

  return (
    <section className="card" aria-labelledby="cc-app-update-heading">
      <div className="section-header" id="cc-app-update-heading">App update</div>

      <dl className="settings-facts">
        <Row label="This app">{version ? `v${version}` : loaded ? 'Unknown' : 'Checking'}</Row>
      </dl>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.8rem',
          color: 'var(--t2)',
          cursor: 'pointer',
          minHeight: 44,
          padding: '0 4px',
          marginTop: '0.5rem',
          borderRadius: 'var(--radius)',
        }}
      >
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(e) => saveAppUpdatePrefs({ ...readAppUpdatePrefs(), enabled: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
        Check for app updates automatically
      </label>

      <div aria-live="polite" style={{ marginTop: '0.5rem' }}>
        <p style={{ margin: 0 }}>Last checked: {checked || 'never'}</p>
        {prefs.ready && <p style={{ margin: '0.5rem 0 0' }}>{prefs.ready.version} is ready to install.</p>}
        {!prefs.ready && !prefs.lastError && checked && (
          <p style={{ margin: '0.5rem 0 0' }}>You have the newest version.</p>
        )}
        {needsAllow && (
          <p style={{ margin: '0.5rem 0 0' }}>
            Android has to allow Polaris to install apps once. Allow it on the page that opened, then press Install again.
          </p>
        )}
      </div>

      {(prefs.lastError || error) && (
        <div style={{ marginTop: '0.75rem' }}>
          <ErrorBanner message={error ? error.message : prefs.lastError} />
        </div>
      )}

      <div style={{ ...ROW_STYLE, marginTop: '0.75rem' }}>
        {prefs.ready && (
          <button type="button" className="btn btn-primary" disabled={installing} onClick={install}>
            Install {prefs.ready.version}
          </button>
        )}
        <button type="button" className="btn" disabled={checking} onClick={checkNow}>
          Check now
        </button>
        <a className="btn" href={RELEASES_PAGE} target="_blank" rel="noopener noreferrer">
          Releases page
        </a>
      </div>

      <p style={{ fontSize: '0.8rem', color: 'var(--t2)', marginTop: '0.75rem', marginBottom: 0 }}>
        The app checks GitHub for a newer release on its own, with no sign-in, and downloads the APK into its own storage. Before offering it, the app checks that it is Polaris signed with the same certificate as this one. Android still asks you to confirm the install once.
      </p>
    </section>
  )
}
