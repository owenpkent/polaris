import { test, expect } from './fixtures.js'
import { createTask, openNavigation, openView } from './support.js'

test.describe('completing a task shows an undoable toast', { tag: ['@flow'] }, () => {
  test('complete, Undo, and the task is back in the list', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'undo complete')
    await openView(page)
    await page.getByRole('checkbox', { name: `Complete ${title}` }).click()

    const undo = page.getByRole('button', { name: `Undo completing ${title}` })
    await expect(undo).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: `Completed ${title}` })).toBeVisible()
    // The row leaves the list once its check has celebrated.
    await expect(page.getByRole('checkbox', { name: `Complete ${title}` })).toHaveCount(0)

    await undo.click()
    await expect(undo).toHaveCount(0)
    await expect(page.getByRole('checkbox', { name: `Complete ${title}` })).toBeVisible()
  })

  test('an Undo that fails after leaving the page says so, and Retry reopens the task', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'undo fails')
    await openView(page)
    await page.getByRole('checkbox', { name: `Complete ${title}` }).click()
    const undo = page.getByRole('button', { name: `Undo completing ${title}` })
    await undo.hover() // holds the toast's timer while the page changes
    await openNavigation(page, testInfo)
    await page.getByRole('button', { name: 'Goals', exact: true }).click()
    await expect(undo).toBeVisible()

    const reopen = /\/api\/tasks\/[^/]+\/reopen$/
    await page.route(reopen, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"no"}}' }))
    await undo.click()
    await expect(page.getByRole('status').filter({ hasText: `Could not reopen ${title}` })).toBeVisible()

    await page.unroute(reopen)
    await page.getByRole('button', { name: `Retry reopening ${title}` }).click()
    await expect(page.getByRole('status').filter({ hasText: `Could not reopen ${title}` })).toHaveCount(0)
    await openView(page)
    await expect(page.getByRole('checkbox', { name: `Complete ${title}` })).toBeVisible()
  })
})
