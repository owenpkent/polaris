import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { isNativeApp } from './command-center/nativeApp'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// The service worker keeps the app shell for when the server cannot be reached. Production only:
// under the Vite dev server it would cache modules that are meant to hot reload. The Android app
// ships the shell inside the app, so it has nothing for a service worker to keep.
if (import.meta.env.PROD && !isNativeApp() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        const urls = performance.getEntriesByType('resource').map((entry) => entry.name)
        registration.active?.postMessage({ type: 'precache', urls })
      })
      .catch(() => {})
  })
}
