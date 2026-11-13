import { useCallback, useEffect, useRef, useState } from 'react'
import { isNativeApp, getAppInfo } from './nativeApp'
import { isNewerVersion, parseVersion } from './appUpdate'
import {
  readAppUpdatePrefs, installReadyUpdate, laterAppUpdate, getPromptState,
  APP_UPDATE_CHANGED_EVENT, APP_UPDATE_PROMPT_EVENT,
} from './appAutoUpdate'

function Prompt() {
  const [running, setRunning] = useState(null)
  const [prefs, setPrefs] = useState(readAppUpdatePrefs)
  const [state, setState] = useState(getPromptState)
  const [error, setError] = useState(null)
  const dialogRef = useRef(null)
  const installRef = useRef(null)

  useEffect(() => {
    let live = true
    getAppInfo().then((info) => { if (live) setRunning(info?.version || null) }, () => {})
    return () => { live = false }
  }, [])

  useEffect(() => {
    const onPrefs = () => setPrefs(readAppUpdatePrefs())
    const onPrompt = () => setState(getPromptState())
    window.addEventListener(APP_UPDATE_CHANGED_EVENT, onPrefs)
    window.addEventListener(APP_UPDATE_PROMPT_EVENT, onPrompt)
    return () => {
      window.removeEventListener(APP_UPDATE_CHANGED_EVENT, onPrefs)
      window.removeEventListener(APP_UPDATE_PROMPT_EVENT, onPrompt)
    }
  }, [])

  const ready = prefs.ready
  const open = Boolean(ready && parseVersion(running) && isNewerVersion(ready.version, running) && state.dismissed !== ready.version)

  const later = useCallback(() => { laterAppUpdate().catch(() => {}) }, [])

  async function install() {
    setError(null)
    try {
      await installReadyUpdate()
    } catch (e) {
      setError(e?.message || 'The install could not start.')
    }
  }

  // Focus goes in on open and back to where it was on close.
  useEffect(() => {
    if (!open) return undefined
    const before = document.activeElement
    installRef.current?.focus()
    return () => {
      if (before && typeof before.focus === 'function' && document.contains(before)) before.focus()
    }
  }, [open])

  // Esc is Later, and Tab stays inside.
  useEffect(() => {
    if (!open) return undefined
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        later()
        return
      }
      if (e.key !== 'Tab') return
      e.stopPropagation()
      const focusables = dialogRef.current ? Array.from(dialogRef.current.querySelectorAll('button')) : []
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !dialogRef.current.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, later])

  if (!open) return null
  return (
    <div className="modal-backdrop search-backdrop">
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="cc-app-update-prompt-title" style={{ maxWidth: 360 }}>
        <div className="section-header" id="cc-app-update-prompt-title">Update ready</div>
        <p style={{ margin: 0, overflowWrap: 'anywhere' }}>Polaris {ready.version} is downloaded and checked.</p>
        {state.needsAllow && (
          <p role="status" style={{ margin: '0.75rem 0 0' }}>Allow Polaris to install apps in Android settings, then come back.</p>
        )}
        {error && <p role="alert" style={{ margin: '0.75rem 0 0', color: 'var(--red)' }}>{error}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
          <button type="button" className="btn" onClick={later}>Later</button>
          <button type="button" className="btn btn-primary" ref={installRef} onClick={install}>Install</button>
        </div>
      </div>
    </div>
  )
}

// Offers the downloaded update in the app itself, Android app only. Renders nothing elsewhere.
export default function AppUpdatePrompt() {
  return isNativeApp() ? <Prompt /> : null
}
