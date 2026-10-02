import { test, expect } from './fixtures.js'
import { openView, smallTargets } from './support.js'

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test.describe('Digest', { tag: ['@flow'] }, () => {
  test('is built for today', async ({ page }) => {
    await openView(page, 'digest')
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(`Command Center Digest - ${localToday()}`)
  })

  test('lists overdue, today, and upcoming tasks under their headings', async ({ page }) => {
    await openView(page, 'digest')
    const main = page.locator('main')
    await expect(page.getByRole('heading', { name: /^Overdue \(\d+\)$/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /^Today \(\d+\)$/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /^Upcoming \(7 days\) \(\d+\)$/ })).toBeVisible()
    await expect(main).toContainText('Renew domain for the portfolio site')
    await expect(main).toContainText('Reply to accessibility audit feedback')
    await expect(main).toContainText('Draft ADR-003 hosting options')
  })

  test('marks third-party text as untrusted and leaves the owner\'s own tasks unmarked', async ({ page }) => {
    await openView(page, 'digest')
    const items = page.getByRole('listitem')
    const own = items.filter({ hasText: 'Reply to accessibility audit feedback' }).first()
    await expect(own).not.toContainText('UNTRUSTED-TEXT')
    // Every line that came from GitHub, Gmail, or Calendar carries the marker.
    const external = items.filter({ hasText: /via (github|gmail|gcal)/ })
    const texts = await external.allTextContents()
    for (const text of texts) expect(text).toContain('UNTRUSTED-TEXT')
  })

  test('renders source text as text, never as a link or markup it did not write', async ({ page }) => {
    await openView(page, 'digest')
    // Source URLs appear in the digest body as plain text. Only http(s) and mailto links may be
    // clickable at all (SafeMarkdown), so no link may carry any other scheme.
    const hrefs = await page.locator('main a').evaluateAll((els) => els.map((el) => el.getAttribute('href')))
    for (const href of hrefs) expect(href).toMatch(/^(https?:\/\/|mailto:)/)
  })

  test('Refresh rebuilds the digest and the button is a 44px target', async ({ page }) => {
    await openView(page, 'digest')
    const refresh = page.getByRole('button', { name: 'Refresh' })
    expect(await smallTargets(page.locator('main'), 'button')).toEqual([])
    const reload = page.waitForResponse((res) => res.url().includes('/api/digest') && res.status() === 200)
    await refresh.click()
    await reload
    await expect(page.getByRole('heading', { level: 2 })).toContainText('Command Center Digest')
  })
})
