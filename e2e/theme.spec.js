import { test, expect } from './fixtures.js'
import { openView, MIN_TARGET } from './support.js'

// What the unit tests in src/theme.test.js cannot reach: the pre-paint script in index.html, and
// a choice surviving a reload.
function themeAttribute(page) {
  return page.evaluate(() => document.documentElement.dataset.theme)
}

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const n = parseInt(h, 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

test.describe('theme', { tag: ['@a11y', '@theme'] }, () => {
  test('the top bar offers System, Light, and Dark at 44px', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Theme' }).click()

    const menu = page.getByRole('menu', { name: 'Theme' })
    await expect(menu).toBeVisible()
    for (const name of ['System', 'Light', 'Dark']) {
      const item = menu.getByRole('menuitemradio', { name })
      await expect(item).toBeVisible()
      const box = await item.boundingBox()
      expect(box.height, `${name} is a 44px target`).toBeGreaterThanOrEqual(MIN_TARGET)
    }
    await expect(menu.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  test('Esc closes the menu and returns focus to the button', async ({ page }) => {
    await openView(page)
    const button = page.getByRole('button', { name: 'Theme' })
    await button.click()
    await expect(page.getByRole('menu', { name: 'Theme' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Theme' })).toHaveCount(0)
    await expect(button).toBeFocused()
  })

  test('picking Light repaints the page and survives a reload', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.forcedColors === 'active', 'forced colours paint the page with system colours, not the token')
    await page.emulateMedia({ colorScheme: 'dark' })
    await openView(page)
    expect(await themeAttribute(page)).toBe('dark')

    await page.getByRole('button', { name: 'Theme' }).click()
    await page.getByRole('menuitemradio', { name: 'Light' }).click()
    expect(await themeAttribute(page)).toBe('light')
    // The page background really repainted, not just the attribute. Compare against the token
    // rather than a literal, so retuning the light palette does not fail this test.
    const { background, token } = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      token: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    }))
    expect(background).toBe(hexToRgb(token))

    // No flash of the wrong theme on the way back: the pre-paint script in index.html reads the
    // same stored choice before React mounts.
    await page.reload()
    expect(await themeAttribute(page)).toBe('light')
    await page.getByRole('button', { name: 'Theme' }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  test('System follows the OS setting both ways', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await openView(page)
    expect(await themeAttribute(page)).toBe('light')

    // Without a reload: the media query listener re-resolves in place.
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => themeAttribute(page)).toBe('dark')

    // And back again. A listener that only acts when e.matches is true would pass the first
    // half of this test and leave a dark-OS user stuck after they switch their OS to light.
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => themeAttribute(page)).toBe('light')
  })
})
