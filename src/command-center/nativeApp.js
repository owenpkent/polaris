import { parseShareParams } from './shareIntake'

// True inside the Android app (mobile/), where Capacitor injects window.Capacitor into the
// WebView. The dashboard has no dependency on Capacitor: this is the one place it looks for it.
export function isNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.())
  } catch {
    return false
  }
}

// Calls `onShare(share)` for each share the Android shell delivers. The shell turns a share intent
// into an appUrlOpen event whose URL carries the share-title, share-text and share-url parameters
// (shareIntake.js). The bridge's own window.Capacitor.addListener is used because the page does not
// load Capacitor's JavaScript runtime, so there is no plugin object to ask. Returns an unsubscribe;
// outside the app it does nothing and returns a no-op.
export function subscribeNativeShares(onShare) {
  const noop = () => {}
  if (!isNativeApp()) return noop
  try {
    const cap = window.Capacitor
    if (typeof cap.addListener !== 'function') return noop
    const handle = cap.addListener('App', 'appUrlOpen', ({ url } = {}) => {
      try {
        const share = parseShareParams(new URL(url).search)
        if (share) onShare(share)
      } catch {
        // A URL that does not parse is not a share.
      }
    })
    return () => {
      try {
        handle?.remove?.()
      } catch {
        // Nothing to remove.
      }
    }
  } catch {
    return noop
  }
}
