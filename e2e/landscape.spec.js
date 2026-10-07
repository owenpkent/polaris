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

  // 844px wide is the desktop layout, so the navigation is the sidebar. It is taller than the
  // screen here, and must scroll on its own to bring its last item, Settings, into reach.
  test('the sidebar scrolls to its last item', async ({ page }) => {
    await openView(page)
    const settings = page.getByRole('navigation', { name: 'Navigation' }).getByRole('button', { name: /^Settings/ })
    await settings.scrollIntoViewIfNeeded()
    await onScreen(page, settings)
    await settings.click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings')
  })
})
