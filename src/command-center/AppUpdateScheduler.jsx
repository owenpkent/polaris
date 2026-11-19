import { useEffect } from 'react'
import { isNativeApp, getAppInfo, subscribeAppResume, subscribeAppUpdateTaps } from './nativeApp'
import { runAppUpdateCheck, installReadyUpdate, continueInstallOnResume, APP_UPDATE_CHANGED_EVENT } from './appAutoUpdate'

const HOUR_MS = 60 * 60 * 1000

// Checks for a newer app by itself, Android app only: on start, on resume, once an hour while the
// app is open, and when the settings change. appAutoUpdate.js decides whether a check is due.
// Renders nothing.
function Scheduler() {
  useEffect(() => {
    let live = true
    async function check() {
      let version = null
      try {
        version = (await getAppInfo())?.version || null
      } catch {
        // An unknown version is offered the newest release.
      }
      if (live) await runAppUpdateCheck({ running: version })
    }
    const run = () => { check().catch(() => {}) }
    run()
    const timer = setInterval(run, HOUR_MS)
    window.addEventListener(APP_UPDATE_CHANGED_EVENT, run)
    const offResume = subscribeAppResume(() => {
      continueInstallOnResume().catch(() => {})
      run()
    })
    const offTap = subscribeAppUpdateTaps(() => { installReadyUpdate().catch(() => {}) })
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener(APP_UPDATE_CHANGED_EVENT, run)
      offResume()
      offTap()
    }
  }, [])
  return null
}

export default function AppUpdateScheduler() {
  return isNativeApp() ? <Scheduler /> : null
}
