import { test, expect } from './fixtures.js'
import { openView, openTask } from './support.js'

// A phone turned sideways: 844px wide, 390px tall (the phone-landscape project). Anything that
// opens on top of the page must keep its close control on screen without scrolling, and Esc must
// still close it. Only the phone-landscape project runs these; the tag keeps them out of the rest.

async function onScreen(page, locator) {
  const box = await locator.boundingBox()
  const height = await page.evaluate(() => window.innerHeight)
  expect(box, 'the control has no box').not.toBeNull()
  expect(box.y + box.height, 'the control is below the bottom of the screen').toBeLessThanOrEqual(height)
  expect(box.y, 'the control is above the top of the screen').toBeGreaterThanOrEqual(0)
}

test.describe('landscape phone', { tag: ['@landscape'] }, () => {
  test('the task details panel keeps its close control on screen and closes on Esc', async ({ page }) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await onScreen(page, panel.getByRole('button', { name: 'Close task details' }))
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })

  test('the navigation drawer keeps its close control on screen and closes on Esc', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await onScreen(page, drawer.getByRole('button', { name: 'Close navigation' }))
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
  })
})
