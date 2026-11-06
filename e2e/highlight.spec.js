import { test, expect } from './fixtures.js'
import { createTask, openView, isPhone } from './support.js'

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

  // At this width the Board shows a lane and part of the next, so the third starts off screen.
  for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`a card moved into a lane off to the side comes into view (${reducedMotion})`, async ({ page, request }, testInfo) => {
      const title = await createTask(request, testInfo, `side lane ${reducedMotion}`, { project: 'ui-test-project', section: 'Backlog', dueAt: null })
      await page.emulateMedia({ reducedMotion })
      await page.setViewportSize({ width: 390, height: 844 })
      await openView(page, 'board')
      const target = page.getByRole('region', { name: 'No section', exact: true })
      await expect(target.getByRole('heading', { name: 'No section' })).not.toBeInViewport()

      await page.getByRole('button', { name: `Move ${title}`, exact: true }).click()
      await page.getByRole('menu', { name: `Move ${title}` }).getByRole('menuitem', { name: 'No section' }).click()
      await expect(target.getByRole('button', { name: new RegExp(`^${title}`) })).toBeInViewport({ ratio: 0.9 })
    })
  }
})
