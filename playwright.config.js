import { defineConfig } from '@playwright/test'

// UI tests (npm run test:ui). They drive the installed Microsoft Edge, so no browser download is
// needed, against throwaway Command Center servers, one per worker, that e2e/server.js seeds
// with demo data. The real database is never opened. Two projects cover the 640px breakpoint: a desktop
// viewport and a true 390px phone viewport.
//
// colorScheme is pinned because the app now defaults to 'system'. Left unset, Playwright reports
// 'light' and the whole suite would quietly stop exercising the dark theme, which is the fallback
// in src/index.css. A spec that wants the light theme calls page.emulateMedia itself.
//
// The shots-* projects run only e2e/shots.spec.js (npm run shots): the same two widths, each in
// both themes, writing screenshots under .shots/ instead of asserting anything.
const PORT = Number(process.env.CC_UI_PORT) || 8791

const DESKTOP = { viewport: { width: 1280, height: 800 } }
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true }
// 320px is 400 percent zoom of a 1280px window (WCAG 1.4.10, initiatives/ui-ux-testing.md phase 7):
// the narrowest width the dashboard must reflow at without sideways scroll.
const PHONE_320 = { viewport: { width: 320, height: 568 }, hasTouch: true }
const SHOTS = /shots\.spec\.js/

const shotProjects = [['phone', PHONE], ['desktop', DESKTOP]].flatMap(([width, use]) =>
  ['dark', 'light'].map((colorScheme) => ({
    name: `shots-${width}-${colorScheme}`,
    testMatch: SHOTS,
    use: { ...use, colorScheme },
    snapshotPathTemplate: '{testDir}/../.shots/baseline/{arg}{ext}',
  }))
)

export default defineConfig({
  testDir: 'e2e',
  // e2e/conventions.test.js is a Vitest file (npm test); Playwright runs only the .spec.js files.
  testMatch: /\.spec\.js$/,
  globalSetup: './e2e/global-setup.js',
  // Every worker has its own server and database (e2e/fixtures.js), so tests can run at the same
  // time, and any test may run in any worker: the suite never shared state between tests. The
  // CI runner has four cores and no headroom for more than one Edge and one server: four workers
  // made the median test take ten seconds instead of four and the slowest time out, and two
  // workers took longer a part than one, so CI runs one worker in four parts (test.yml). The PC
  // has the cores for four. Pass --workers to choose.
  fullyParallel: true,
  workers: process.env.CI ? 1 : 4,
  retries: 0,
  timeout: 30000,
  reporter: [['list']],
  outputDir: '.playwright',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // CC_UI_BROWSER=chromium runs on Playwright's own Chromium where Edge is not installed (Linux).
    channel: process.env.CC_UI_BROWSER || 'msedge',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    colorScheme: 'dark',
  },
  projects: [
    { name: 'desktop', use: DESKTOP, testIgnore: SHOTS, grepInvert: /@landscape|@narrow|@perf/ },
    { name: 'phone', use: PHONE, testIgnore: SHOTS, grepInvert: /@landscape|@narrow|@perf/ },
    // The light theme, for the tests tagged @theme only (initiatives/ui-ux-testing.md, phase 3):
    // the axe sweep, the focus ring checks, and theme.spec.js. Everything else runs once, in dark.
    { name: 'desktop-light', use: { ...DESKTOP, colorScheme: 'light' }, testIgnore: SHOTS, grep: /@theme/ },
    { name: 'phone-light', use: { ...PHONE, colorScheme: 'light' }, testIgnore: SHOTS, grep: /@theme/ },
    // Windows High Contrast (phase 7): forced colours strip backgrounds and box shadows, so the
    // focus ring, control edges, and selected states must survive on outlines and borders alone.
    { name: 'desktop-hc', use: { ...DESKTOP, forcedColors: 'active' }, testIgnore: SHOTS, grep: /@theme/ },
    // A phone turned sideways (phase 7): 844px wide, so the desktop layout, but only 390px tall.
    // Runs the panel, sheet, and drawer tests tagged @landscape: the close control must be on
    // screen without scrolling and Esc must still work.
    { name: 'phone-landscape', use: { viewport: { width: 844, height: 390 }, hasTouch: true }, testIgnore: SHOTS, grep: /@landscape/ },
    // 320px reflow (phase 7): runs only e2e/narrow.spec.js, tagged @narrow. isPhone in e2e/support.js
    // reads the viewport width, so this project gets the phone expectations.
    { name: 'phone-320', use: PHONE_320, testIgnore: SHOTS, grep: /@narrow/ },
    // Report-only perceived-performance timings (initiatives/ui-ux-testing.md, "Perceived
    // performance, report only"). Desktop only, and run on request, not by npm run test:ui:
    // `CC_UI_PERF=1 npx playwright test --project perf`. e2e/perf.spec.js skips itself when
    // CC_UI_PERF is not set to 1, since the 500-task seed only exists then.
    { name: 'perf', use: DESKTOP, testIgnore: SHOTS, grep: /@perf/ },
    ...shotProjects,
  ],
})
