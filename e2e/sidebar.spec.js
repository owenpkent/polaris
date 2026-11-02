import { test, expect } from './fixtures.js'
import { openView, smallTargets } from './support.js'

// The desktop sidebar can be hidden, the owner's choice per device (src/sidebarState.js). Hidden is
// gone, not a rail, and it is kept across a reload. Under 640px there is no sidebar to hide, so
// these steps only run at desktop widths.
const wide = (page) => (page.viewportSize()?.width ?? 0) > 640

test.describe('the sidebar toggle', { tag: ['@flow'] }, () => {
  test('hides the sidebar so the content takes the width, survives a reload, and shows it again', async ({ page }) => {
    test.skip(!wide(page), 'the phone has no sidebar')
    await openView(page)
    const sidebar = page.getByRole('navigation', { name: 'Navigation' })
    const toggle = page.getByRole('button', { name: 'Hide sidebar' })
    await expect(sidebar).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveAttribute('aria-controls', 'app-sidebar')
    expect((await toggle.boundingBox()).width).toBeGreaterThanOrEqual(44)
    const before = (await page.getByRole('main').boundingBox()).width

    await toggle.click()
    await expect(sidebar).toBeHidden()
    const show = page.getByRole('button', { name: 'Show sidebar' })
    await expect(show).toHaveAttribute('aria-expanded', 'false')
    await expect(show).toBeFocused()
    const after = (await page.getByRole('main').boundingBox()).width
    expect(after).toBeGreaterThan(before)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await openView(page)
    await expect(sidebar).toBeHidden()
    await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible()

    await page.getByRole('button', { name: 'Show sidebar' }).click()
    await expect(sidebar).toBeVisible()
    await openView(page)
    await expect(sidebar).toBeVisible()
  })

  test('Ctrl+Backslash toggles it, and focus inside the sidebar moves to the toggle when it hides', async ({ page }) => {
    test.skip(!wide(page), 'the phone has no sidebar')
    await openView(page)
    await page.getByRole('navigation', { name: 'Navigation' }).getByRole('button').first().focus()
    await page.keyboard.press('Control+Backslash')
    await expect(page.getByRole('navigation', { name: 'Navigation' })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()
    await page.keyboard.press('Control+Backslash')
    await expect(page.getByRole('navigation', { name: 'Navigation' })).toBeVisible()
  })

  test('the toggle is a whole target and is not on the phone', async ({ page }) => {
    await openView(page)
    if (wide(page)) {
      expect(await smallTargets(page.getByRole('banner'), '.topbar-sidebar-btn')).toEqual([])
    } else {
      await expect(page.getByRole('button', { name: /sidebar$/ })).toHaveCount(0)
    }
  })
})
