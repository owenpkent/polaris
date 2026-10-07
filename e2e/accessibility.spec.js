import { test, expect } from './fixtures.js'
import { openView, openTask, openNavigation, expectNoHorizontalOverflow, smallTargets, expectFocusRing } from './support.js'

// The accessibility rules in CLAUDE.md, checked in a real browser at both widths: 44px click
// targets, a visible focus ring, Esc closes panels and menus, and no sideways page scroll.

const VIEWS = ['mytasks', 'inbox', 'board', 'rules', 'digest', 'github', 'settings']

// Long and awkward titles from command-center/src/dev/seed-ui-test.ts, "UI Test Text" project:
// three open tasks with no section and no due date, so they all land in the collapsed "No due
// date" group on My tasks. Built the same way the seed builds them, so the titles match exactly.
const LONG_TITLE = 'Polaris'.repeat(43).slice(0, 300)
const RTL_TITLE = 'هذه مهمة تجريبية لفحص التخطيط من اليمين إلى اليسار'
const URL_TITLE =
  'https://example.com/' +
  'a/very/long/path/that/keeps/going/to/check/how/the/dashboard/handles/an/unbroken/url/' +
  'as/a/task/title/without/wrapping/or/causing/horizontal/scroll/on/a/narrow/phone/screen'
const TEXT_TASKS = [
  { label: 'the 300-character title', title: LONG_TITLE },
  { label: 'the right-to-left title', title: RTL_TITLE },
  { label: 'the URL title', title: URL_TITLE },
]

test.describe('layout', { tag: ['@a11y'] }, () => {
  for (const view of VIEWS) {
    test(`${view} never scrolls the page sideways`, async ({ page }) => {
      await openView(page, view)
      await expectNoHorizontalOverflow(page)
    })
  }

  test('My tasks with the task panel open does not scroll sideways', async ({ page }) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('the inbox accept form does not scroll sideways', async ({ page }) => {
    await openView(page, 'inbox')
    await page.getByRole('button', { name: 'Accept' }).last().click()
    await expect(page.getByRole('button', { name: 'Accept as task' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('My tasks with the long, right-to-left, and URL titles present does not scroll sideways', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Expand No due date' }).click()
    for (const { title } of TEXT_TASKS) {
      await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible()
    }
    await expectNoHorizontalOverflow(page)
  })

  for (const { label, title } of TEXT_TASKS) {
    test(`a row with ${label} opens its task panel by that title, and the panel does not scroll sideways`, async ({ page }) => {
      await openView(page)
      await page.getByRole('button', { name: 'Expand No due date' }).click()
      await openTask(page, title)
      await expectNoHorizontalOverflow(page)
    })
  }

  test('the Board view with the UI Test Text project does not scroll sideways', async ({ page }) => {
    await openView(page, 'board')
    await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'UI Test Text' })
    await expect(page.getByRole('region', { name: 'No section', exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })
})

test.describe('44px click targets', { tag: ['@a11y'] }, () => {
  test('top bar and My tasks toolbar', async ({ page }) => {
    await openView(page)
    expect(await smallTargets(page.locator('header'))).toEqual([])
    expect(await smallTargets(page.getByRole('toolbar', { name: 'Tasks' }))).toEqual([])
  })

  test('My tasks rows and group headers', async ({ page }) => {
    await openView(page)
    const offenders = await smallTargets(
      page.locator('main'),
      '[aria-label^="Open "], [aria-label^="Collapse "], [aria-label^="Expand "], [role="checkbox"], [aria-label^="Change "]'
    )
    expect(offenders).toEqual([])
  })

  test('navigation: the sidebar on desktop, the drawer on a phone', async ({ page }, testInfo) => {
    await openView(page)
    expect(await smallTargets(await openNavigation(page, testInfo))).toEqual([])
  })

  test('inbox Accept and Reject, and the accept form buttons', async ({ page }) => {
    await openView(page, 'inbox')
    expect(await smallTargets(page.locator('main'), 'button')).toEqual([])
    await page.getByRole('button', { name: 'Accept' }).last().click()
    await expect(page.getByRole('button', { name: 'Accept as task' })).toBeVisible()
    expect(await smallTargets(page.locator('main'), 'button')).toEqual([])
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('task details panel buttons', async ({ page }) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel).toBeVisible()
    expect(await smallTargets(panel, 'button')).toEqual([])
  })

  test('sort menu items', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Sort' }).click()
    expect(await smallTargets(page.getByRole('menu', { name: 'Sort tasks' }), '[role="menuitemcheckbox"]')).toEqual([])
  })
})

test.describe('keyboard', { tag: ['@a11y', '@theme'] }, () => {
  test('the first Tab stop shows a visible focus ring', async ({ page }) => {
    await openView(page)
    await page.keyboard.press('Tab')
    await expectFocusRing(page)
  })

  test('a focused task row shows a visible focus ring', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Open Reply to accessibility audit feedback', exact: true }).focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expectFocusRing(page)
  })

  test('a task row opens from the keyboard with Enter', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Open Draft ADR-003 hosting options', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible()
  })
})
