import { test as base, expect } from '@playwright/test'
import { freePort, launchApp, makeScratch, startImpostor, startServer } from './app.js'

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

async function attachFailure(testInfo, app) {
  try {
    await testInfo.attach('desktop.log', { body: app.appLog() || '(empty)', contentType: 'text/plain' })
    await testInfo.attach('daemon.log', { body: app.daemonLog() || '(none)', contentType: 'text/plain' })
    await testInfo.attach('app output', { body: app.output() || '(none)', contentType: 'text/plain' })
    if (app.page) {
      await testInfo.attach('window', { body: await app.page.screenshot({ timeout: 5000 }), contentType: 'image/png' })
    }
    if (app.context) {
      const trace = testInfo.outputPath('desktop-trace.zip')
      await app.context.tracing.stop({ path: trace })
      await testInfo.attach('trace', { path: trace, contentType: 'application/zip' })
    }
  } catch (err) {
    console.warn(`Could not attach the app's state: ${err.message}`)
  }
}

export { expect }
