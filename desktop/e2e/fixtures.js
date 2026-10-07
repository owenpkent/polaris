import { writeFileSync } from 'node:fs'
import { test as base, expect } from '@playwright/test'
import { freePort, launchApp, makeScratch, processState, startImpostor, startServer } from './app.js'

// Every spec here imports `test` and `expect` from this file. The `rig` fixture is one test's
// whole world: a scratch folder, a port of its own, a token, and the means to start the app, a
// stand-in daemon, or an impostor against them. Whatever a test starts is stopped when it ends
// (and only that, see the safety notes in app.js), and on failure the app's trace, its logs, and
// a screenshot of the window are attached.
export const test = base.extend({
  rig: async ({}, use, testInfo) => {
    const scratch = makeScratch()
    const port = await freePort()
    const token = `desktop-ui-token-${Math.random().toString(16).slice(2)}`
    const apps = []
    const servers = []
    const impostors = []
    const rig = {
      scratch,
      port,
      token,
      async launch(options = {}) {
        const app = await launchApp(options.scratch ?? scratch, { port, token: options.token ?? token })
        apps.push(app)
        return app
      },
      async server(options = {}) {
        const server = await startServer(options.scratch ?? scratch, { port, token: options.token ?? token })
        servers.push(server)
        return server
      },
      async impostor(respond) {
        const impostor = await startImpostor(port, respond)
        impostors.push(impostor)
        return impostor
      },
    }
    await use(rig)

    for (const app of apps) {
      if (testInfo.status !== testInfo.expectedStatus) {
        await attachFailure(testInfo, app)
      }
      await app.cleanup()
    }
    for (const server of servers) server.kill()
    for (const impostor of impostors) await impostor.stop()
    scratch.remove()
  },
})

// Written as files in the test's output folder, so a CI artifact keeps them whole (the list
// reporter prints only the first lines of an attachment given as a body).
async function attachFailure(testInfo, app) {
  const texts = {
    'desktop.log': () => app.appLog() || '(empty)',
    'daemon.log': () => app.daemonLog() || '(none)',
    'app-output.txt': () => app.output() || '(none)',
    'process-state.txt': () => processState(app),
  }
  for (const [name, read] of Object.entries(texts)) {
    try {
      const file = testInfo.outputPath(name)
      writeFileSync(file, read())
      await testInfo.attach(name, { path: file, contentType: 'text/plain' })
    } catch (err) {
      console.warn(`Could not attach ${name}: ${err.message}`)
    }
  }
  if (app.page) {
    try {
      const file = testInfo.outputPath('window.png')
      await app.page.screenshot({ path: file, timeout: 5000 })
      await testInfo.attach('window', { path: file, contentType: 'image/png' })
    } catch (err) {
      console.warn(`Could not attach the window: ${err.message}`)
    }
  }
  if (app.context) {
    try {
      const trace = testInfo.outputPath('desktop-trace.zip')
      await app.context.tracing.stop({ path: trace })
      await testInfo.attach('trace', { path: trace, contentType: 'application/zip' })
    } catch (err) {
      console.warn(`Could not attach the trace: ${err.message}`)
    }
  }
}

export { expect }
