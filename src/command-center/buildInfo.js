// The dashboard's own build, recorded by vite.config.js when it was built: the package version,
// the short commit, and the moment. The server's version can differ (a dashboard cached by the
// service worker, or the Android app's bundled copy), so Settings shows both.
export const BUILD_INFO = typeof __BUILD_INFO__ === 'undefined'
  ? { version: null, commit: null, builtAt: null }
  : __BUILD_INFO__
