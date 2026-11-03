import { test, expect } from './fixtures.js'
import { openView, isPhone } from './support.js'

// The row of a task the owner just added is tinted for a moment where it now is
// (useJustChanged.js, .just-changed in index.css), then the tint goes.
test.describe('Highlight after a change', { tag: ['@flow'] }, () => {
  test('a task added from the list is highlighted, then not', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'the inline Add task row is a desktop control')
    const title = `UI test highlight ${testInfo.project.name}`
    await openView(page)
    await page.getByRole('button', { name: 'Add task' }).first().click()
    const input = page.getByRole('textbox', { name: 'New task name' })
    await input.fill(title)
    await input.press('Enter')
    const rowEl = page.locator('[data-task-id]').filter({ has: page.getByRole('button', { name: `Rename ${title}`, exact: true }) })
    await expect(rowEl).toBeVisible()
    await expect(rowEl).toHaveClass(/just-changed/)
    await expect(rowEl).not.toHaveClass(/just-changed/, { timeout: 5000 })
  })
})
