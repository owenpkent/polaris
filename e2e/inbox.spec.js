import { test, expect } from './fixtures.js'
import { openView, isPhone, listTaskTitles } from './support.js'

// The inbox holds four seeded suggestions. Accepting or rejecting one uses it up, and the desktop
// and phone runs share one database, so each run changes its own pair and only reads the rest:
// desktop uses the Calendar and Gmail items, phone uses the two GitHub items.
const ITEMS = {
  desktop: { accept: 'Prep: design review call', reject: 'Invoice question from a client' },
  phone: {
    accept: 'Issue assigned: board cards overflow on narrow screens',
    reject: 'Review requested: fix keyboard trap in settings dialog',
  },
}

// One inbox entry: a table row on desktop, a card (list item) on the phone.
function entry(page, testInfo, title) {
  const role = isPhone(testInfo) ? 'listitem' : 'row'
  return page.getByRole(role).filter({ has: page.getByRole('link', { name: title, exact: true }) })
}

test.describe('Inbox', { tag: ['@flow'] }, () => {
  test('its controls stay inside the card at the widths where the sidebar crowds the table', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'the sidebar is only shown above the phone breakpoint')
    await openView(page, 'inbox')
    // The card is a table where the columns fit and a list of cards where they do not; both widths
    // between the phone tier and the sidebar-offset threshold used to clip the name and Accept.
    const card = page.getByRole('table', { name: 'Inbox' }).or(page.getByRole('list', { name: 'Inbox' }))
    const inside = async (locator) => {
      await expect(locator).toBeVisible()
      const [box, within] = await Promise.all([locator.boundingBox(), card.boundingBox()])
      expect(box.x).toBeGreaterThanOrEqual(within.x)
      expect(box.x + box.width).toBeLessThanOrEqual(within.x + within.width + 1)
      expect(box.width).toBeGreaterThan(40)
    }
    for (const width of [768, 900, 1100]) {
      await page.setViewportSize({ width, height: 900 })
      const title = page.getByRole('link', { name: ITEMS.desktop.accept, exact: true })
      await inside(title)
      const entryAt = page.getByRole('row').or(page.getByRole('listitem')).filter({ has: title })
      await inside(entryAt.getByRole('button', { name: 'Accept' }))
      await entryAt.getByRole('button', { name: 'Accept' }).click()
      await inside(page.getByRole('button', { name: 'Accept as task' }))
      await inside(page.getByRole('button', { name: 'Cancel' }))
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('button', { name: 'Accept as task' })).toHaveCount(0)
    }
  })

  test('explains that nothing becomes a task until it is accepted', async ({ page }) => {
    await openView(page, 'inbox')
    await expect(page.locator('main')).toContainText('Nothing becomes a task until you accept it.')
  })

  test('suggestions link back to their source and are not tasks yet', async ({ page, request }, testInfo) => {
    const { accept, reject } = ITEMS[testInfo.project.name]
    await openView(page, 'inbox')
    for (const title of [accept, reject]) {
      await expect(page.getByRole('link', { name: title, exact: true })).toHaveAttribute('href', /^https:\/\//)
      await expect(entry(page, testInfo, title).getByRole('button', { name: 'Accept' })).toBeVisible()
      await expect(entry(page, testInfo, title).getByRole('button', { name: 'Reject' })).toBeVisible()
    }
    await openView(page, 'mytasks')
    for (const title of [accept, reject]) {
      await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toHaveCount(0)
    }
  })

  test('the phone layout stacks suggestions as cards instead of a table', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only')
    await openView(page, 'inbox')
    await expect(page.getByRole('list', { name: 'Inbox' })).toBeVisible()
    await expect(page.getByRole('table', { name: 'Inbox' })).toHaveCount(0)
  })

  test('Accept opens a form first, and Cancel leaves the suggestion in the inbox', async ({ page, request }, testInfo) => {
    const { accept } = ITEMS[testInfo.project.name]
    await openView(page, 'inbox')
    await entry(page, testInfo, accept).getByRole('button', { name: 'Accept' }).click()
    await expect(page.getByRole('textbox', { name: 'Task name' })).toHaveValue(accept)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('textbox', { name: 'Task name' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: accept, exact: true })).toBeVisible()
    expect(await listTaskTitles(request)).not.toContain(accept)
  })

  test('Reject asks for confirmation, and Cancel leaves the suggestion in the inbox', async ({ page }, testInfo) => {
    const { reject } = ITEMS[testInfo.project.name]
    await openView(page, 'inbox')
    await entry(page, testInfo, reject).getByRole('button', { name: 'Reject' }).click()
    await expect(page.getByRole('button', { name: 'Confirm reject' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('button', { name: 'Confirm reject' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: reject, exact: true })).toBeVisible()
  })

  test('accepting with an edited name creates that task and removes the suggestion', async ({ page }, testInfo) => {
    const { accept } = ITEMS[testInfo.project.name]
    const edited = `${accept} (accepted on ${testInfo.project.name})`
    await openView(page, 'inbox')
    await entry(page, testInfo, accept).getByRole('button', { name: 'Accept' }).click()
    await page.getByRole('textbox', { name: 'Task name' }).fill(edited)
    await page.getByRole('button', { name: 'Accept as task' }).click()
    await expect(page.getByRole('link', { name: accept, exact: true })).toHaveCount(0)
    await openView(page, 'mytasks')
    for (const group of ['Later', 'No due date']) {
      const expand = page.getByRole('button', { name: `Expand ${group}` })
      if (await expand.count()) await expand.click()
    }
    await expect(page.getByRole('button', { name: `Open ${edited}`, exact: true })).toBeVisible()
  })

  test('a confirmed reject removes the suggestion and never creates a task', async ({ page, request }, testInfo) => {
    const { reject } = ITEMS[testInfo.project.name]
    await openView(page, 'inbox')
    await entry(page, testInfo, reject).getByRole('button', { name: 'Reject' }).click()
    await page.getByRole('textbox', { name: 'Why is this being rejected?' }).fill('Not needed, rejected by the UI tests')
    await page.getByRole('button', { name: 'Confirm reject' }).click()
    await expect(page.getByRole('link', { name: reject, exact: true })).toHaveCount(0)
    await openView(page, 'inbox')
    await expect(page.getByRole('link', { name: reject, exact: true })).toHaveCount(0)
    expect(await listTaskTitles(request)).not.toContain(reject)
  })
})
