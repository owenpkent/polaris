import { defineConfig } from '@playwright/test'

// UI tests for the real desktop app (npm run test:desktop:ui). They sit beside the shell, not in
// the root e2e/, because they drive a different thing: the debug build of desktop/src-tauri, not
// a browser pointed at a scratch server. e2e/conventions.test.js and e2e/fixtures.js are built for
// that browser suite (a frozen clock, one server per worker, the 390px phone projects), and none
// of it applies to a native window, so this folder has its own config and fixtures and keeps the
// rules that do apply: select by role or accessible name, tag every describe, no exact counts.
//
// Playwright does not launch anything here. desktop/e2e/app.js starts the app with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=0 (an HKLM policy says the same
// where the shell is elevated, see launchApp), reads the port Chromium chose from the profile's
// DevToolsActivePort file, and the tests attach with chromium.connectOverCDP. That reuses the
// Playwright install: no tauri-driver, and no msedgedriver matched to the WebView2 runtime.
//
// One worker, one app at a time: the shell is a single-instance app (tauri-plugin-single-instance),
// so a second copy would only focus the first.
export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.js$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [['list']],
  outputDir: '../../desktop-test-output',
})
