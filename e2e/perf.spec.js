import { test, expect } from './fixtures.js'
import { openView, openTask } from './support.js'

// Report-only perceived-performance timings (initiatives/ui-ux-testing.md, "Perceived
// performance, report only"). Numbers go to the test output and to testInfo.attach; there is no
// threshold yet, so every assertion here only checks that a number was actually measured
// (Number.isFinite), never a bound on how big it is.
//
// These tests need the 500-task, 200-card seed from command-center/src/dev/seed-perf.ts, which
// e2e/global-setup.js only runs when CC_UI_PERF=1. They are not part of `npm run test:ui`; run
// them on request with `CC_UI_PERF=1 npx playwright test --project perf`.

// A task row's button, not the top bar's Open navigation button, whose name also starts with Open.
const ROW = /^Open Perf task /

test.describe('Perceived performance (report only)', { tag: ['@perf'] }, () => {
  test.beforeEach(() => {
    test.skip(process.env.CC_UI_PERF !== '1', 'set CC_UI_PERF=1 to seed the 500-task project this spec measures against')
  })

  test('My tasks: time to the first row and the number of rows rendered', async ({ page }, testInfo) => {
    await openView(page)
    const rows = page.getByRole('button', { name: ROW })
    await rows.first().waitFor({ state: 'visible' })
    // performance.now() is relative to the navigation that openView started, so this is the
    // elapsed time from navigation start to the first row becoming visible.
    const elapsed = await page.evaluate(() => performance.now())
    const count = await rows.count()

    await testInfo.attach('time to first row (ms)', { body: String(elapsed), contentType: 'text/plain' })
    await testInfo.attach('rows rendered', { body: String(count), contentType: 'text/plain' })
    console.log(`[${testInfo.project.name}] My tasks: first row at ${elapsed}ms, ${count} rows rendered`)

    expect(Number.isFinite(elapsed)).toBe(true)
    expect(Number.isFinite(count)).toBe(true)
  })

  test('My tasks: time to open and close a task panel', async ({ page }, testInfo) => {
    await openView(page)
    const rows = page.getByRole('button', { name: ROW })
    await rows.first().waitFor({ state: 'visible' })
    const label = await rows.first().getAttribute('aria-label')
    const title = label.replace(/^Open /, '')
    const panel = page.getByRole('dialog', { name: 'Task details' })

    const openStart = await page.evaluate(() => performance.now())
    await openTask(page, title)
    const openElapsed = (await page.evaluate(() => performance.now())) - openStart

    const closeStart = await page.evaluate(() => performance.now())
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    const closeElapsed = (await page.evaluate(() => performance.now())) - closeStart

    await testInfo.attach('time to open the task panel (ms)', { body: String(openElapsed), contentType: 'text/plain' })
    await testInfo.attach('time to close the task panel (ms)', { body: String(closeElapsed), contentType: 'text/plain' })
    console.log(`[${testInfo.project.name}] task panel: open ${openElapsed}ms, close ${closeElapsed}ms`)

    expect(Number.isFinite(openElapsed)).toBe(true)
    expect(Number.isFinite(closeElapsed)).toBe(true)
  })

  test('Board with the perf project: time to the first lane and to open a Move menu', async ({ page }, testInfo) => {
    await openView(page, 'board')
    const laneStart = await page.evaluate(() => performance.now())
    await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'UI Perf Project' })
    const lane = page.getByRole('region', { name: 'To do', exact: true })
    await expect(lane).toBeVisible()
    const laneElapsed = (await page.evaluate(() => performance.now())) - laneStart

    const moveButton = lane.getByRole('button', { name: /^Move /, exact: false }).first()
    await moveButton.waitFor({ state: 'visible' })
    const menuStart = await page.evaluate(() => performance.now())
    await moveButton.click()
    await expect(page.getByRole('menu')).toBeVisible()
    const menuElapsed = (await page.evaluate(() => performance.now())) - menuStart

    await testInfo.attach('time to the first lane (ms)', { body: String(laneElapsed), contentType: 'text/plain' })
    await testInfo.attach('time to open a Move menu (ms)', { body: String(menuElapsed), contentType: 'text/plain' })
    console.log(`[${testInfo.project.name}] Board: first lane ${laneElapsed}ms, Move menu ${menuElapsed}ms`)

    expect(Number.isFinite(laneElapsed)).toBe(true)
    expect(Number.isFinite(menuElapsed)).toBe(true)
  })

  test('My tasks: layout shift and long tasks while scrolling to the bottom and back', async ({ page }, testInfo) => {
    // Installed before any page script runs, so nothing the initial render causes is missed
    // (as refresh.spec.js does for the layout-shift observer). A long task is not part of the
    // CLS metric, but the same buffered-observer approach reports it when the browser supports
    // the 'longtask' entry type; where it does not, the count stays at zero rather than failing.
    await page.addInitScript(() => {
      window.__cls = 0
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) window.__cls += entry.value
          }
        }).observe({ type: 'layout-shift', buffered: true })
      } catch {
        window.__cls = null
      }
      window.__longTasks = 0
      try {
        new PerformanceObserver((list) => {
          window.__longTasks += list.getEntries().length
        }).observe({ type: 'longtask', buffered: true })
      } catch {
        window.__longTasks = null
      }
    })

    await openView(page)
    const rows = page.getByRole('button', { name: ROW })
    await rows.first().waitFor({ state: 'visible' })

    const settled = () => page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ cls: window.__cls, longTasks: window.__longTasks })))
    }))
    await settled()

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await settled()
    await page.evaluate(() => window.scrollTo(0, 0))
    const { cls, longTasks } = await settled()

    await testInfo.attach('cumulative layout shift while scrolling', { body: String(cls), contentType: 'text/plain' })
    await testInfo.attach('long tasks observed while scrolling', { body: String(longTasks), contentType: 'text/plain' })
    console.log(`[${testInfo.project.name}] scrolling My tasks: layout shift ${cls}, long tasks ${longTasks}`)

    expect(Number.isFinite(cls)).toBe(true)
    // 'longtask' is not universally supported; only assert finiteness where it was observed.
    if (longTasks !== null) expect(Number.isFinite(longTasks)).toBe(true)
  })
})
