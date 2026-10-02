import { test as base, expect } from '@playwright/test'
import { BASE_PORT, startScratchServer } from './server.js'

// Every spec imports `test` and `expect` from here, not from @playwright/test.
//
// The worker fixture starts this worker's own Command Center server on a fresh scratch database
// (e2e/server.js), so workers share nothing and can run at the same time; baseURL and the
// handoff in e2e/support.js follow it. The clock fixture freezes the browser's clock to the
// moment that database was seeded (initiatives/ui-ux-testing.md, phase 1, option A). From that instant the
// clock runs at real speed, so timers, polling, and debounces behave as they do for the owner, but
// "Today", "Tomorrow", the digest heading, and the due-date buckets read the same on every run
// of a given seed, whatever the wall clock says. That is what makes screenshot comparison
// possible. The seed moment is real time, so a run that crosses local midnight fails loudly.
export const test = base.extend({
  scratchServer: [
    async ({}, use, workerInfo) => {
      const server = await startScratchServer(BASE_PORT + workerInfo.parallelIndex)
      // Read by e2e/support.js (the handoff URL) and by the clock fixture, in this worker only.
      process.env.CC_UI_WORKER_PORT = String(server.port)
      process.env.CC_UI_SEED_TIME = server.seededAt
      await use(server)
      await server.stop()
    },
    { scope: 'worker', auto: true },
  ],
  baseURL: async ({ scratchServer }, use) => {
    await use(scratchServer.url)
  },
  // An uncaught exception in the page fails the test that was running. Console errors are not
  // failures here (a deliberately unreachable server logs plenty); they are attached instead.
  pageErrors: [
    async ({ page }, use, testInfo) => {
      const errors = []
      const logged = []
      page.on('pageerror', (err) => errors.push(err.stack || String(err)))
      page.on('console', (msg) => {
        if (msg.type() === 'error') logged.push(msg.text())
      })
      await use(errors)
      if (logged.length) await testInfo.attach('console errors', { body: logged.join('\n'), contentType: 'text/plain' })
      expect(errors, 'uncaught exceptions in the page').toEqual([])
    },
    { auto: true },
  ],
  frozenClock: [
    async ({ page }, use) => {
      const seeded = process.env.CC_UI_SEED_TIME
      if (!seeded) throw new Error('CC_UI_SEED_TIME is not set: the scratchServer fixture did not run')
      await page.clock.install({ time: new Date(seeded) })
      await use(undefined)
    },
    { auto: true },
  ],
})

export { expect }
