import { test, expect } from './fixtures.js'
import { createTask, openView } from './support.js'

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
})
