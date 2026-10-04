// True inside the Android app (mobile/), where Capacitor injects window.Capacitor into the
// WebView. The dashboard has no dependency on Capacitor: this is the one place it looks for it.
export function isNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.())
  } catch {
    return false
  }
}
