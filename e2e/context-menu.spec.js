import { test, expect } from './fixtures.js'
import { createTask, openView } from './support.js'

// The row's own element, which takes the right-click (the Open button is only its panel target).
const rowEl = (page, title) => page.locator('[data-task-id]').filter({ has: page.getByRole('button', { name: `Rename ${title}`, exact: true }) })

test.describe('Task context menu', { tag: ['@flow'] }, () => {
  test('right-click on a My tasks row opens the menu, and Tomorrow sets the due date', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'menu due')
    await openView(page)
    const row = rowEl(page, title)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right', position: { x: 200, y: 10 } })
    const menu = page.getByRole('menu', { name: `Actions for ${title}` })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Tomorrow' }).click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByRole('button', { name: `Change due date for ${title}` })).toHaveText('Tomorrow')
    // The menu did not open the panel.
    await expect(page.getByRole('dialog', { name: 'Task details' })).toHaveCount(0)
  })

  test('the menu sets the priority and opens the task', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'menu priority')
    await openView(page)
    const row = rowEl(page, title)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right', position: { x: 200, y: 10 } })
    await page.getByRole('menuitemradio', { name: 'Urgent' }).click()
    // The phone layout has no priority column, so the menu itself shows the new level.
    await row.click({ button: 'right', position: { x: 200, y: 10 } })
    await expect(page.getByRole('menuitemradio', { name: 'Urgent' })).toBeChecked()
    await page.getByRole('menuitem', { name: 'Open task' }).click()
    await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible()
  })

  test('Shift+F10 opens it from the keyboard, arrows move, and Esc returns focus', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'menu keys')
    await openView(page)
    const open = page.getByRole('button', { name: `Open ${title}`, exact: true })
    await open.scrollIntoViewIfNeeded()
    await open.focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: `Actions for ${title}` })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Open task' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Complete' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(open).toBeFocused()
  })

  test('Complete in the menu completes the task', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'menu complete')
    await openView(page)
    const row = rowEl(page, title)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right', position: { x: 200, y: 10 } })
    await page.getByRole('menuitem', { name: 'Complete' }).click()
    await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toHaveCount(0)
  })

  test('a right-click in the name field while renaming keeps the browser menu', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'menu rename')
    await openView(page)
    await page.getByRole('button', { name: `Rename ${title}` }).click()
    const input = page.getByRole('textbox', { name: 'Task name' })
    await expect(input).toBeFocused()
    const prevented = await input.evaluate((el) => {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      el.dispatchEvent(ev)
      return ev.defaultPrevented
    })
    expect(prevented).toBe(false)
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('right-click on a Board card opens the menu, and a section moves the card', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'menu board', { project: 'ui-test-project', section: 'Backlog', dueAt: null })
    await openView(page, 'board')
    const cardIn = (lane) => page.getByRole('region', { name: lane, exact: true }).getByRole('button', { name: new RegExp(`^${title}`) })
    await cardIn('Backlog').scrollIntoViewIfNeeded()
    await cardIn('Backlog').click({ button: 'right' })
    const menu = page.getByRole('menu', { name: `Actions for ${title}` })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitemradio', { name: 'Doing' }).click()
    await expect(cardIn('Doing')).toBeVisible()
  })
})
