import { test, expect } from './fixtures.js'
import { createTask, openView } from './support.js'

// A task the owner sends to another group or lane is not scrolled to (useJustChanged.js). The
// toast says where it went, without taking focus, and offers View, which goes there, and Undo.
const rowEl = (page, title) => page.locator('[data-task-id]').filter({ has: page.getByRole('button', { name: `Rename ${title}`, exact: true }) })

test.describe('the toast after a move', { tag: ['@flow'] }, () => {
  test('a task sent to Tomorrow says so, and View goes to it', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'moved view')
    await openView(page)
    const row = rowEl(page, title)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right', position: { x: 200, y: 10 } })
    await page.getByRole('menu', { name: `Actions for ${title}` }).getByRole('menuitem', { name: 'Tomorrow' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'Moved' })).toContainText(`Moved ${title} to Tomorrow`)
    const view = page.getByRole('button', { name: `View ${title} in Tomorrow` })
    await expect(view).not.toBeFocused()
    await view.click()
    const open = page.getByRole('button', { name: `Open ${title}`, exact: true })
    await expect(open).toBeFocused()
    await expect(open).toBeInViewport()
    await expect(page.getByRole('button', { name: `Change due date for ${title}` })).toContainText('Tomorrow')
  })

  test('Undo puts the task back where it was', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'moved undo')
    await openView(page)
    const row = rowEl(page, title)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right', position: { x: 200, y: 10 } })
    await page.getByRole('menu', { name: `Actions for ${title}` }).getByRole('menuitem', { name: 'No due date' }).click()
    await page.getByRole('button', { name: `Undo moving ${title} to No due date` }).click()
    await expect(page.getByRole('button', { name: `Change due date for ${title}` })).toContainText('Today')
    await expect(page.getByRole('button', { name: /^View / })).toHaveCount(0)
  })

  test('an edit that leaves the task in its group shows no toast', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'moved none')
    await openView(page)
    const row = rowEl(page, title)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right', position: { x: 200, y: 10 } })
    await page.getByRole('menu', { name: `Actions for ${title}` }).getByRole('menuitemradio', { name: 'Urgent' }).click()
    await expect(page.getByRole('button', { name: `Undo moving ${title} to Today` })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^View / })).toHaveCount(0)
  })

  // At this width the Board shows a lane and part of the next, so the third starts off screen.
  test('a card moved to a lane off to the side says so, and View scrolls to it', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'moved card', { project: 'ui-test-project', section: 'Backlog', dueAt: null })
    await page.setViewportSize({ width: 390, height: 844 })
    await openView(page, 'board')
    await page.getByRole('button', { name: `Move ${title}`, exact: true }).click()
    await page.getByRole('menu', { name: `Move ${title}` }).getByRole('menuitem', { name: 'No section' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Moved' })).toContainText(`Moved ${title} to No section`)
    const card = page.getByRole('region', { name: 'No section', exact: true }).getByRole('button', { name: new RegExp(`^${title}`) })
    await expect(card).not.toBeInViewport()
    await page.getByRole('button', { name: `View ${title} in No section` }).click()
    await expect(card).toBeInViewport({ ratio: 0.9 })
    await expect(card).toBeFocused()
  })
})
