import { test, expect } from './fixtures.js'
import { openView, expectFocusRing, isPhone, smallTargets } from './support.js'

test.describe('navigation', { tag: ['@flow'] }, () => {
  test('opens on My tasks and shows it as the page title', async ({ page }) => {
    await openView(page)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My tasks')
  })

  test('desktop shows every view in the sidebar, with no menu button', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'desktop layout only')
    await openView(page)
    const sidebar = page.getByRole('navigation', { name: 'Navigation' })
    await expect(sidebar).toBeVisible()
    for (const name of ['My tasks', 'Board', 'Goals', 'Projects', 'Checklists', 'Threads', 'Rules', 'Digest', 'GitHub']) {
      await expect(sidebar.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await expect(sidebar.getByRole('button', { name: /^Inbox, \d+ waiting$/ })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: /^Settings/ })).toContainText('Connected')
    await expect(sidebar.getByRole('button', { name: 'My tasks' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden()
    expect(await smallTargets(sidebar)).toEqual([])
  })

  test('choosing a view in the sidebar switches the page and updates the URL', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'desktop layout only')
    await openView(page)
    const sidebar = page.getByRole('navigation', { name: 'Navigation' })
    await sidebar.getByRole('button', { name: 'Goals', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Goals')
    await expect(sidebar.getByRole('button', { name: 'Goals', exact: true })).toHaveAttribute('aria-current', 'page')
    expect(new URL(page.url()).searchParams.get('view')).toBe('goals')
  })

  test('the sidebar is reachable from the keyboard and shows a focus ring', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'desktop layout only')
    await openView(page)
    const sidebar = page.getByRole('navigation', { name: 'Navigation' })
    await sidebar.getByRole('button', { name: 'My tasks' }).focus()
    await page.keyboard.press('Tab')
    await expect(sidebar.getByRole('button', { name: /^Inbox/ })).toBeFocused()
    await expectFocusRing(page)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inbox')
  })

  test('the drawer lists the primary views and reports the connection', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only: desktop has the sidebar')
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await expect(drawer.getByRole('button', { name: 'My tasks' })).toBeVisible()
    await expect(drawer.getByRole('button', { name: /^Inbox/ })).toBeVisible()
    await expect(drawer.getByRole('button', { name: 'Board' })).toBeVisible()
    await expect(drawer.getByRole('button', { name: /^Settings/ })).toContainText('Connected')
    await expect(drawer.getByRole('button', { name: 'My tasks' })).toHaveAttribute('aria-current', 'page')
  })

  test('choosing a view switches the page, closes the drawer, and updates the URL', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only: desktop has the sidebar')
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: /^Inbox/ }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inbox')
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('view')).toBe('inbox')
  })

  test('Esc closes the drawer and focus returns to the menu button', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only: desktop has the sidebar')
    await openView(page)
    const menuButton = page.getByRole('button', { name: 'Open navigation' })
    await menuButton.click()
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0)
    await expect(menuButton).toBeFocused()
  })

  test('Tab stays inside the open drawer and the focused item shows a ring', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only: desktop has the sidebar')
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      const inside = await drawer.evaluate((el) => el.contains(document.activeElement))
      expect(inside, `focus left the drawer after ${i + 1} Tab presses`).toBe(true)
    }
    await expectFocusRing(page)
  })

  test('More expands to the secondary views', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only: desktop has the sidebar')
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    const more = drawer.getByRole('button', { name: 'More' })
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    for (const name of ['Goals', 'Projects', 'Rules', 'Digest', 'GitHub']) {
      await expect(drawer.getByRole('button', { name, exact: true })).toBeVisible()
    }
  })

  test('?view= opens that view directly and an unknown value falls back to My tasks', async ({ page }) => {
    await openView(page, 'board')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Board')
    await openView(page, 'nonsense')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My tasks')
  })

  test('the API token never stays in the address bar', async ({ page }) => {
    await openView(page)
    expect(page.url()).not.toContain('cc-token')
  })
})

// The phone's tab bar (src/BottomNav.jsx). Desktop navigates through the sidebar.
test.describe('phone tab bar', { tag: ['@flow'] }, () => {
  test('is hidden on desktop', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'phone layout only')
    await openView(page)
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden()
  })

  test('switches views, marks the current one, and offers 44px targets', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only')
    await openView(page)
    const bar = page.getByRole('navigation', { name: 'Primary' })
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('button', { name: 'My tasks' })).toHaveAttribute('aria-current', 'page')
    expect(await smallTargets(bar)).toEqual([])
    await bar.getByRole('button', { name: 'Board' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Board')
    await expect(bar.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-current', 'page')
    expect(new URL(page.url()).searchParams.get('view')).toBe('board')
  })

  test('More opens the drawer and Esc returns focus to More', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only')
    await openView(page)
    const more = page.getByRole('button', { name: 'More views' })
    await more.click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'More' }).click()
    await expect(drawer.getByRole('button', { name: 'Goals', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(more).toBeFocused()
  })

  test('the Inbox item counts the waiting suggestions', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only')
    await openView(page)
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: /^Inbox, \d+ waiting$/ })).toBeVisible()
  })
})
