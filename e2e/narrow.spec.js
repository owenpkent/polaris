import { test, expect } from './fixtures.js'
import { openView, openTask, expectNoHorizontalOverflow, smallTargets } from './support.js'

// 320px wide (the phone-320 project): 400 percent zoom of a 1280px window, the reflow width of
// WCAG 1.4.10 (initiatives/ui-ux-testing.md, phase 7). The views must reflow without sideways page
// scroll, and every control must still be a 44px target. Only the phone-320 project runs these;
// the tag keeps them out of the rest.

// The long and awkward titles from command-center/src/dev/seed-ui-test.ts ("UI Test Text"), built
// the same way the seed builds them. They sit in the collapsed "No due date" group on My tasks.
const LONG_TITLE = 'Polaris'.repeat(43).slice(0, 300)
const URL_TITLE =
  'https://example.com/' +
  'a/very/long/path/that/keeps/going/to/check/how/the/dashboard/handles/an/unbroken/url/' +
  'as/a/task/title/without/wrapping/or/causing/horizontal/scroll/on/a/narrow/phone/screen'

test.describe('320px reflow', { tag: ['@narrow'] }, () => {
  for (const view of ['mytasks', 'inbox', 'board']) {
    test(`${view} never scrolls the page sideways at 320px`, async ({ page }) => {
      await openView(page, view)
      await expectNoHorizontalOverflow(page)
    })
  }

  test('My tasks with the No due date group expanded does not scroll sideways at 320px', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Expand No due date' }).click()
    for (const title of [LONG_TITLE, URL_TITLE]) {
      await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible()
    }
    await expectNoHorizontalOverflow(page)
  })

  test('the Board with the UI Test Text project does not scroll the page sideways at 320px', async ({ page }) => {
    await openView(page, 'board')
    await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'UI Test Text' })
    await expect(page.getByRole('region', { name: 'No section', exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('the task details panel opens, does not scroll sideways, and keeps 44px buttons at 320px', async ({ page }) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel).toBeVisible()
    await expectNoHorizontalOverflow(page)
    expect(await smallTargets(panel, 'button')).toEqual([])
  })

  test('the task details panel for the URL title does not scroll sideways at 320px', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Expand No due date' }).click()
    await openTask(page, URL_TITLE)
    await expectNoHorizontalOverflow(page)
  })

  test('the navigation drawer items are 44px at 320px', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await expect(drawer).toBeVisible()
    expect(await smallTargets(drawer)).toEqual([])
    await expectNoHorizontalOverflow(page)
  })
})
