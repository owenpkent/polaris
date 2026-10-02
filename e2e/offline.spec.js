import { test, expect } from './fixtures.js'
import { createGoal, createTask, expectNoHorizontalOverflow, isPhone, listTaskTitles, openView } from './support.js'
import { TOKEN } from './global-setup.js'

// The offline clone (initiatives/offline-clone.md). Cutting the browser's network stands in for
// the server going away: the service worker has to supply the app shell and the local copy in
// IndexedDB has to supply the data.

// The first visit caches its files a moment after load (main.jsx sends the list to sw.js), so
// wait for the page itself to be in the cache before pulling the plug.
async function goOffline(page) {
  await expect.poll(
    () => page.evaluate(async () => Boolean(await caches.match('/'))),
    { message: 'the service worker never cached the app shell', timeout: 15000 }
  ).toBe(true)
  await page.context().setOffline(true)
}

test.afterEach(async ({ page }) => {
  await page.context().setOffline(false)
})

test('My tasks still opens and lists tasks with the server unreachable', { tag: ['@flow'] }, async ({ page, request }, testInfo) => {
  const title = await createTask(request, testInfo, 'offline list')
  await openView(page, 'mytasks')
  await expect(page.getByText(title, { exact: true })).toBeVisible()

  await goOffline(page)
  await page.reload()

  const banner = page.getByRole('status').filter({ hasText: 'Offline.' })
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Showing data from')
  await expect(page.getByText(title, { exact: true })).toBeVisible()
  // Task edits are queued offline, so their controls stay on.
  await expect(page.getByRole('button', { name: 'Add task' }).first()).toBeEnabled()
  await expectNoHorizontalOverflow(page)
})

test('a tab that was never opened on this device is there offline', { tag: ['@flow'] }, async ({ page }) => {
  await openView(page, 'mytasks')
  await goOffline(page)

  await page.goto('/?view=projects')
  await expect(page.getByRole('status').filter({ hasText: 'Offline.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'New project' })).toBeDisabled()
})

test('the banner clears and the other controls come back when the server returns', { tag: ['@flow'] }, async ({ page }) => {
  await openView(page, 'mytasks')
  await goOffline(page)
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'Offline.' })).toBeVisible()

  await page.context().setOffline(false)
  // The events poll runs every 10 seconds; the first one to succeed ends offline mode.
  await expect(page.getByRole('status').filter({ hasText: 'Offline.' })).toBeHidden({ timeout: 20000 })
  await page.goto('/?view=projects')
  await expect(page.getByRole('button', { name: 'New project' })).toBeEnabled()
})

// Local mode: a device with no saved connection (initiatives/offline-clone.md). The page is
// opened without the #cc-url handoff, so nothing connects it.
test('a task completed before the first connection leaves the list, and stays out after a reload', { tag: ['@flow'] }, async ({ page }, testInfo) => {
  const title = `UI test local done ${testInfo.project.name}`
  await page.goto('/?view=mytasks')
  if (isPhone(testInfo)) {
    await page.getByRole('button', { name: 'New task' }).click()
    const sheet = page.getByRole('dialog', { name: 'New task' })
    await sheet.getByRole('textbox', { name: 'New task name' }).fill(title)
    await sheet.getByRole('button', { name: 'Today', exact: true }).click()
    await sheet.getByRole('button', { name: 'Create' }).click()
    await expect(sheet).toHaveCount(0)
  } else {
    await page.getByRole('button', { name: 'Add task' }).first().click()
    const input = page.getByRole('textbox', { name: 'New task name' })
    await input.fill(title)
    await input.press('Enter')
  }
  await expect(page.getByRole('checkbox', { name: `Complete ${title}` })).toBeVisible()

  await page.getByRole('checkbox', { name: `Complete ${title}` }).click()
  await expect(page.getByText(title, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '2 changes waiting' })).toBeVisible()

  // There is no server to refresh from: the copy itself must leave the done task out.
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: '2 changes waiting' })).toBeVisible()
  await expect(page.getByText(title, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: `Reopen ${title}` })).toHaveCount(0)
})

test('a task added and another completed offline reach the server when it returns', { tag: ['@flow'] }, async ({ page, request }, testInfo) => {
  const existing = await createTask(request, testInfo, 'offline complete')
  const added = `UI test offline add ${testInfo.project.name} ${Date.now()}`
  await openView(page, 'mytasks')
  await expect(page.getByText(existing, { exact: true })).toBeVisible()
  await goOffline(page)
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'Offline.' })).toBeVisible()

  await page.getByRole('button', { name: 'Add task' }).first().click()
  const input = page.getByRole('textbox', { name: 'New task name' })
  await input.fill(added)
  await input.press('Enter')
  await expect(page.getByText(added, { exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: `Complete ${existing}` }).click()
  await expect(page.getByRole('status').filter({ hasText: '2 changes waiting' })).toBeVisible()

  // Still there after a reload with no server: the queue and the patched copy are on disk.
  await page.reload()
  await expect(page.getByText(added, { exact: true })).toBeVisible()
  expect(await listTaskTitles(request)).not.toContain(added)

  await page.context().setOffline(false)
  await expect(page.getByRole('status').filter({ hasText: '2 offline changes sent.' })).toBeVisible({ timeout: 20000 })
  const titles = await listTaskTitles(request)
  expect(titles).toContain(added)
  expect(titles).not.toContain(existing)
  await expect(page.getByText(added, { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

// The Goal filter decides from the task list as it is on this device, so an edit queued offline
// moves a task out of (or into) a goal's work before the server has seen it. The goals answer
// from the local copy, with the goal's linked projects, and the row's project change is patched
// into the local task list by the outbox.
test('a task moved out of a goal\'s project offline leaves the Goal filter', { tag: ['@flow'] }, async ({ page, request }, testInfo) => {
  test.skip(isPhone(testInfo), 'the phone tier shows only Name and Due date, so it has no project menu')
  const goal = await createGoal(request, testInfo, 'offline project')
  const goals = await (await request.get('/api/goals', { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
  const goalId = goals.goals.find((g) => g.title === goal).id
  const linked = await request.post(`/api/goals/${goalId}/links`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    data: { project: 'ui-test-project' },
  })
  expect(linked.ok(), `link goal failed: ${linked.status()}`).toBeTruthy()
  const title = await createTask(request, testInfo, 'offline goal', { project: 'ui-test-project' })

  await openView(page, 'mytasks')
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: goal }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Filter (1)' })).toBeVisible()
  await expect(page.getByText(title, { exact: true })).toBeVisible()

  await goOffline(page)
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'Offline.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Filter (1)' })).toBeVisible()
  await expect(page.getByText(title, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: `Change project for ${title}` }).click()
  await page.getByRole('menu', { name: `Project for ${title}` }).getByRole('menuitemcheckbox', { name: 'None' }).click()
  await expect(page.getByText(title, { exact: true })).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: '1 change waiting' })).toBeVisible()

  // The server still has it in the project, and so in the goal, until the edit is sent.
  await page.context().setOffline(false)
  await expect(page.getByRole('status').filter({ hasText: '1 offline change sent.' })).toBeVisible({ timeout: 20000 })
  const after = await (await request.get('/api/goals', { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
  expect(after.goals.find((g) => g.id === goalId).linkedWork.projectIds.length).toBe(1)
  await expect(page.getByText(title, { exact: true })).toBeHidden()
})
