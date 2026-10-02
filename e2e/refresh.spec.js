import { test, expect } from './fixtures.js'
import { openView, isPhone, createTask, openTask, nudgePoll } from './support.js'
import { TOKEN } from './global-setup.js'

// Refresh stability (initiatives/ui-ux-testing.md, phase 6). Every view polls /api/events
// through src/command-center/useEvents.js: once on mount and then every 10 seconds, comparing
// the server's newest event id with the last one it saw, and refetching its own data when the
// id has moved. A "refresh" here is therefore a real one: the test changes data through the
// REST API and waits for the dashboard to notice on its next poll. No fake timers, no reload.
// The browser clock from fixtures.js runs at real speed, so the poll fires as it does for the owner.

const row = (page, title) => page.getByRole('button', { name: `Open ${title}`, exact: true })
const lane = (page, name) => page.getByRole('region', { name, exact: true })
const card = (scope, title) => scope.getByRole('button', { name: new RegExp(`^${title}`) })
const headers = { Authorization: `Bearer ${TOKEN}` }

// A refresh takes at most one poll interval plus the refetch. The suite timeout is 30 seconds,
// so a wait for the change gets 20 of them, well past the 10-second interval.
const REFRESH = { timeout: 20000 }

async function taskIdByTitle(request, title) {
  const res = await request.get('/api/tasks', { headers })
  expect(res.ok()).toBeTruthy()
  const task = (await res.json()).tasks.find((t) => t.title === title)
  expect(task, `no task titled ${title}`).toBeTruthy()
  return task.id
}

async function patchTask(request, id, patch) {
  const res = await request.patch(`/api/tasks/${id}`, { headers, data: patch })
  expect(res.ok(), `patch task failed: ${res.status()}`).toBeTruthy()
}

test.describe('My tasks across a data refresh', { tag: ['@flow'] }, () => {
  test('a focused row keeps focus when a task created elsewhere joins the list', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'refresh focus')
    await openView(page)
    const target = row(page, title)
    await target.focus()
    await expect(target).toBeFocused()

    const arrival = await createTask(request, testInfo, 'refresh arrival')

    await nudgePoll(page)
    await expect(row(page, arrival)).toBeVisible(REFRESH)

    const focused = await page.evaluate(() => {
      const el = document.activeElement
      return el ? el.getAttribute('aria-label') || el.textContent.trim() : null
    })
    expect(focused).toBe(`Open ${title}`)
    await expect(target).toBeFocused()
  })

  test('an open row menu stays open with the same items across a refresh', async ({ page, request }, testInfo) => {
    test.skip(isPhone(testInfo), 'the phone tier shows only Name and Due date, so it has no priority menu')
    const title = await createTask(request, testInfo, 'refresh menu')
    await openView(page)
    await page.getByRole('button', { name: `Change priority for ${title}` }).click()
    const menu = page.getByRole('menu', { name: `Priority for ${title}` })
    await expect(menu).toBeVisible()
    const before = await menu.getByRole('menuitemcheckbox').allTextContents()
    expect(before.length).toBeGreaterThan(0)

    const arrival = await createTask(request, testInfo, 'refresh menu arrival')

    await nudgePoll(page)
    await expect(row(page, arrival)).toBeVisible(REFRESH)

    await expect(menu).toBeVisible()
    expect(await menu.getByRole('menuitemcheckbox').allTextContents()).toEqual(before)
  })

  test('a draft in the panel survives a refresh that changes another field of the same task', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'refresh draft')
    const id = await taskIdByTitle(request, title)
    await openView(page)
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel.getByRole('combobox', { name: 'Priority' })).toHaveValue('none')

    // Type without leaving the field: blur is what saves, so the text is a draft until then.
    const notes = panel.getByRole('textbox', { name: 'Notes' })
    await notes.fill('Typed while the server changed the priority')
    await expect(notes).toBeFocused()

    await patchTask(request, id, { priority: 'high' })

    await nudgePoll(page)
    await expect(panel.getByRole('combobox', { name: 'Priority' })).toHaveValue('high', REFRESH)

    await expect(notes).toHaveValue('Typed while the server changed the priority')
    await expect(notes).toBeFocused()
  })

  test('layout shift caused by a refresh is measured (report only)', async ({ page, request }, testInfo) => {
    // Runs before any page script, so no shift is missed. Shifts caused by the user's own input
    // are left out, the way the CLS metric defines them.
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
    })
    const title = await createTask(request, testInfo, 'refresh shift baseline')
    await openView(page)
    await expect(row(page, title)).toBeVisible()
    // Two frames, so the observer has delivered everything the first render caused.
    const settled = () => page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__cls)))
    }))
    const before = await settled()
    expect(before, 'the layout-shift observer did not install').toEqual(expect.any(Number))

    const arrival = await createTask(request, testInfo, 'refresh shift arrival')

    await nudgePoll(page)
    await expect(row(page, arrival)).toBeVisible(REFRESH)
    const after = await settled()
    const shift = after - before

    await testInfo.attach('layout shift on refresh', { body: String(shift), contentType: 'text/plain' })
    console.log(`[${testInfo.project.name}] layout shift on refresh: ${shift}`)
    // Report only for now (initiatives/ui-ux-testing.md, phase 6). A threshold comes later.
    expect(Number.isFinite(shift)).toBe(true)
  })
})

test.describe('Board across a data refresh', { tag: ['@flow'] }, () => {
  test('an open Move menu stays open while the card takes a title changed elsewhere', async ({ page, request }, testInfo) => {
    // Own card in the seeded UI Test Project, so the seeded cards keep their titles.
    const title = await createTask(request, testInfo, 'refresh board', { project: 'ui-test-project', section: 'Backlog', dueAt: null })
    const id = await taskIdByTitle(request, title)
    const renamed = `${title} renamed`
    await openView(page, 'board')
    await expect(card(lane(page, 'Backlog'), title)).toBeVisible()
    await page.getByRole('button', { name: `Move ${title}`, exact: true }).click()
    const menu = page.getByRole('menu', { name: `Move ${title}` })
    await expect(menu).toBeVisible()
    const before = await menu.getByRole('menuitem').allTextContents()
    expect(before).toContain('Doing')

    await patchTask(request, id, { title: renamed })

    await nudgePoll(page)
    await expect(card(lane(page, 'Backlog'), renamed)).toBeVisible(REFRESH)

    // The menu is labelled by the card's title, so it now answers to the new name.
    const after = page.getByRole('menu', { name: `Move ${renamed}` })
    await expect(after).toBeVisible()
    expect(await after.getByRole('menuitem').allTextContents()).toEqual(before)
    await expect(after.getByRole('menuitem', { name: 'Backlog' })).toBeDisabled()
  })
})
