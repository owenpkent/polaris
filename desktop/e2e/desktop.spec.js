import { alive, daemonsOnPort, until } from './app.js'
import { expect, test } from './fixtures.js'

// What the real desktop app does at start and at close, read from desktop/src-tauri/src/main.rs:
// boot() asks the port for GET /api/identity with a fresh challenge (probe), and only a reply
// holding the HMAC proof for this database's api token counts as a Command Center. Then:
//   proof right     -> use that server, start nothing, leave it running at exit
//   nothing there   -> start the bundled daemon as a child, wait for it, own it, kill it at exit
//   anything else   -> start nothing, show the error page, never send the token
// Each test runs the app on its own scratch database, secrets, backups, and port (app.js).

async function expectDashboard(app) {
  await expect.poll(() => app.page.url(), { message: 'the window moves to the daemon\'s own URL' }).toMatch(
    new RegExp(`^http://127\\.0\\.0\\.1:${app.port}/`),
  )
  await expect(app.page.getByRole('heading', { level: 1 })).toHaveText('My tasks')
  // The Settings row of the navigation carries the connection status (e2e/navigation.spec.js reads it the same way).
  await expect(app.page.getByRole('navigation', { name: 'Navigation' }).getByRole('button', { name: /^Settings/ })).toContainText('Connected')
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function createTask(app, title, port = app.port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, dueAt: today() }),
  })
  expect(res.ok, `create task failed: ${res.status}`).toBeTruthy()
}

test.describe('desktop app, cold start', { tag: ['@flow'] }, () => {
  test('starts the bundled daemon and lands on a working dashboard', async ({ rig }) => {
    const app = await rig.launch()
    await expectDashboard(app)

    // The shell started exactly the daemon it owns, on this test's port and scratch database.
    expect(app.appLog()).toContain(`port ${rig.port}, database ${rig.scratch.db}`)
    const daemons = app.daemonChildren()
    expect(daemons.length).toBeGreaterThan(0)
    expect(daemons[0].commandLine).toContain(`daemon --port ${rig.port}`)
    expect(daemonsOnPort(rig.port)).toContain(daemons[0].pid)

    // A view backed by the API: a task made through the daemon shows up in the window.
    const title = `Desktop UI cold start ${Date.now()}`
    await createTask(app, title)
    await app.page.reload()
    await expect(app.page.getByRole('heading', { level: 1 })).toHaveText('My tasks')
    await expect(app.page.getByText(title)).toBeVisible()

    // The handoff fragment is cleared once the dashboard has taken the connection.
    expect(new URL(app.page.url()).hash).toBe('')
  })
})

test.describe('desktop app, a daemon already on the port', { tag: ['@flow'] }, () => {
  test('reuses a daemon that proves the token, starts none, and leaves it running at exit', async ({ rig }) => {
    const server = await rig.server()
    const title = `Desktop UI reused daemon ${Date.now()}`
    await createTask({ token: rig.token, port: rig.port }, title)

    const app = await rig.launch()
    await expectDashboard(app)
    // Only the server that was already there can have this task: the window is on it.
    await expect(app.page.getByText(title)).toBeVisible()

    expect(app.appLog()).toContain('already running on the port; using it')
    expect(app.daemonChildren()).toEqual([])
    expect(daemonsOnPort(rig.port)).toEqual([])
    expect(app.daemonLog(), 'the shell wrote no daemon log, so it started no daemon').toBe('')

    // Closing the app leaves a daemon it did not start alone.
    expect(app.close()).toBeGreaterThan(0)
    await until('the app to exit', () => app.exited(), { timeout: 20000 })
    expect(alive(server.pid)).toBe(true)
    expect((await fetch(`http://127.0.0.1:${rig.port}/api/identity?challenge=${'0'.repeat(32)}`)).ok).toBe(true)
  })
})

test.describe('desktop app, something else on the port', { tag: ['@flow'] }, () => {
  const cases = [
    {
      name: 'an HTTP server with no identity proof is not trusted',
      respond: () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      message: /did not prove it holds this database's token/,
    },
    {
      name: 'a server that is not a Command Center (HTTP 401) is not trusted',
      respond: () => ({ status: 401, body: '{}' }),
      message: /already in use \(HTTP 401\) by a server that is not a Command Center/,
    },
    {
      name: 'a wrong proof is not trusted',
      respond: () => ({ status: 200, body: JSON.stringify({ proof: '0'.repeat(64) }) }),
      message: /did not prove it holds this database's token/,
    },
  ]

  for (const { name, respond, message } of cases) {
    test(name, async ({ rig }) => {
      const impostor = await rig.impostor(respond)
      const app = await rig.launch()

      // The start page stays up with the error, and says how to get out of it.
      await expect(app.page.getByRole('alert')).toContainText(message)
      await expect(app.page.getByRole('alert')).toContainText('set CC_PORT')
      await expect(app.page.getByRole('status')).toHaveText('Could not start')
      expect(app.page.url()).not.toContain(`127.0.0.1:${rig.port}`)

      // The shell asked who was there, and nothing else: no token, no other path.
      expect(impostor.requests.length).toBeGreaterThan(0)
      for (const request of impostor.requests) {
        expect(request.url).toMatch(/^\/api\/identity\?challenge=[0-9a-f]{64}$/)
        expect(request.headers.authorization).toBeUndefined()
        expect(JSON.stringify(request)).not.toContain(rig.token)
      }
      // It started no daemon of its own.
      expect(app.daemonChildren()).toEqual([])
      expect(daemonsOnPort(rig.port)).toEqual([])
      expect(app.exited()).toBe(false)
    })
  }

  test('a real daemon holding another token is not trusted either', async ({ rig }) => {
    const other = await rig.server({ token: 'some-other-database-token' })
    const app = await rig.launch()
    await expect(app.page.getByRole('alert')).toContainText("did not prove it holds this database's token")
    expect(app.page.url()).not.toContain(`127.0.0.1:${rig.port}`)
    expect(app.daemonChildren()).toEqual([])
    expect(alive(other.pid)).toBe(true)
  })
})

test.describe('desktop app, closing', { tag: ['@flow'] }, () => {
  test('closing the window stops the daemon the app started and frees the port', async ({ rig }) => {
    const app = await rig.launch()
    await expectDashboard(app)
    const daemons = app.daemonChildren().map((d) => d.pid)
    expect(daemons.length).toBeGreaterThan(0)

    expect(app.close(), 'the close request reached the window').toBeGreaterThan(0)
    await until('the app to exit', () => app.exited(), { timeout: 20000 })

    await until('the daemon to be gone', () => daemons.every((pid) => !alive(pid)), { timeout: 20000 })
    expect(daemonsOnPort(rig.port)).toEqual([])
    await expect(fetch(`http://127.0.0.1:${rig.port}/api/identity?challenge=${'0'.repeat(32)}`)).rejects.toThrow()
  })

  test('closing during the start page also leaves no daemon behind', async ({ rig }) => {
    // The window is asked to close as soon as it exists, before the dashboard has loaded.
    const app = await rig.launch()
    app.close()
    await until('the app to exit', () => app.exited(), { timeout: 30000 })
    await until('no daemon on the port', () => daemonsOnPort(rig.port).length === 0, { timeout: 20000 })
    await expect(fetch(`http://127.0.0.1:${rig.port}/api/identity?challenge=${'0'.repeat(32)}`)).rejects.toThrow()
  })
})
