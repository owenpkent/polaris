import { test, expect } from './fixtures.js'
import { openView, openTask, crowdedTargets } from './support.js'

// Targets that are big enough can still be too close together. WCAG 2.5.8 asks for 24px targets
// or spacing; the bar here is 44px targets (accessibility.spec.js) with at least 8px between
// neighbours, so a click that lands a little off does not land on the next control.

test.describe('target spacing', { tag: ['@a11y'] }, () => {
  test('top bar and My tasks toolbar', async ({ page }) => {
    await openView(page)
    expect(await crowdedTargets(page.locator('header'))).toEqual([])
    expect(await crowdedTargets(page.getByRole('toolbar', { name: 'Tasks' }))).toEqual([])
  })

  test('navigation drawer', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    expect(await crowdedTargets(page.getByRole('dialog', { name: 'Navigation' }))).toEqual([])
  })

  test('task details panel', async ({ page }) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    expect(await crowdedTargets(page.getByRole('dialog', { name: 'Task details' }))).toEqual([])
  })

  test('sort menu', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Sort' }).click()
    expect(await crowdedTargets(page.getByRole('menu', { name: 'Sort tasks' }))).toEqual([])
  })

  test('inbox Accept and Reject', async ({ page }) => {
    await openView(page, 'inbox')
    expect(await crowdedTargets(page.locator('main'), 'button')).toEqual([])
  })
})
