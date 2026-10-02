import { test, expect } from './fixtures.js'
import { openView, createGoal, smallTargets, expectNoHorizontalOverflow } from './support.js'

// Seeded by command-center/src/dev/seed-ui-test.ts: "Ship the UI test project" (linked to the UI
// Test Project, so it has open work and one milestone to count) and "Grow the audience" (a manual
// goal with nothing linked, so it is stalled). Tests that change a goal create their own.

const card = (page, title) => page.getByRole('article', { name: title, exact: true })

async function openDetails(page, title) {
  await page.getByRole('button', { name: `Show details for ${title}`, exact: true }).click()
  await expect(card(page, title).getByRole('textbox', { name: 'Goal title' })).toBeVisible()
}

test.describe('Goals', { tag: ['@flow'] }, () => {
  test('lists goals with status, period, and progress counted from linked work', async ({ page }) => {
    await openView(page, 'goals')
    const shipIt = card(page, 'Ship the UI test project')
    await expect(shipIt).toContainText('2026')
    await expect(shipIt.getByRole('button', { name: /^Status of Ship the UI test project: On track$/ })).toBeVisible()
    // One milestone in the linked project is counted; ordinary project tasks are not.
    await expect(shipIt.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '0 of 1 done (0%)')
    await expect(shipIt).not.toContainText('Stalled')
  })

  test('a goal with nothing open to move it is flagged as stalled, and the summary counts it', async ({ page }) => {
    await openView(page, 'goals')
    const audience = card(page, 'Grow the audience')
    await expect(audience).toContainText('Stalled: no open task')
    await expect(audience.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '250 of 1000 subscribers (25%)')
    await expect(page.getByRole('status')).toContainText(/\d+ goals?, [1-9]\d* need attention/)
  })

  test('details list the open tasks that move the goal', async ({ page }) => {
    await openView(page, 'goals')
    await openDetails(page, 'Ship the UI test project')
    const moving = page.getByRole('region', { name: 'Open tasks that move Ship the UI test project' })
    await expect(moving).toContainText('Board card alpha')
    await expect(moving).toContainText('Board milestone delta')
  })

  test('Add goal needs only a title and a click, and opens the new goal', async ({ page }, testInfo) => {
    const title = `UI test goal typed ${testInfo.project.name}`
    await openView(page, 'goals')
    await page.getByRole('toolbar', { name: 'Goals' }).getByRole('button', { name: 'Add goal' }).click()
    const form = page.getByRole('form', { name: 'New goal' })
    const input = form.getByRole('textbox', { name: 'New goal' })
    await expect(input).toBeFocused()
    await expect(form.getByRole('button', { name: 'Add goal' })).toBeDisabled()
    await input.fill(title)
    await form.getByRole('button', { name: 'No period' }).click()
    await form.getByRole('button', { name: 'Add goal' }).click()
    await expect(form).toHaveCount(0)
    await expect(card(page, title)).toBeVisible()
    // It opens ready for linking, and a brand new goal has nothing moving it yet.
    await expect(card(page, title).getByRole('textbox', { name: 'Goal title' })).toHaveValue(title)
    await expect(card(page, title)).toContainText('Stalled: no open task')
  })

  test('Esc closes the Add goal form without creating anything', async ({ page }) => {
    await openView(page, 'goals')
    await page.getByRole('toolbar', { name: 'Goals' }).getByRole('button', { name: 'Add goal' }).click()
    const form = page.getByRole('form', { name: 'New goal' })
    await form.getByRole('textbox', { name: 'New goal' }).fill('Should never exist')
    await page.keyboard.press('Escape')
    await expect(form).toHaveCount(0)
    await expect(card(page, 'Should never exist')).toHaveCount(0)
  })

  test('status changes from a menu in two clicks and survives a reload', async ({ page, request }, testInfo) => {
    const title = await createGoal(request, testInfo, 'status')
    await openView(page, 'goals')
    await card(page, title).getByRole('button', { name: `Status of ${title}: On track` }).click()
    await page.getByRole('menu', { name: `Status for ${title}` }).getByRole('menuitemcheckbox', { name: 'At risk' }).click()
    await expect(card(page, title).getByRole('button', { name: `Status of ${title}: At risk` })).toBeVisible()
    await openView(page, 'goals')
    await expect(card(page, title).getByRole('button', { name: `Status of ${title}: At risk` })).toBeVisible()
  })

  test('the status menu closes on Esc without changing anything', async ({ page, request }, testInfo) => {
    const title = await createGoal(request, testInfo, 'menu esc')
    await openView(page, 'goals')
    await card(page, title).getByRole('button', { name: `Status of ${title}: On track` }).click()
    await expect(page.getByRole('menu', { name: `Status for ${title}` })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: `Status for ${title}` })).toHaveCount(0)
    await expect(card(page, title).getByRole('button', { name: `Status of ${title}: On track` })).toBeVisible()
  })

  test('a status note is saved and shown on the card', async ({ page, request }, testInfo) => {
    const title = await createGoal(request, testInfo, 'note')
    await openView(page, 'goals')
    await openDetails(page, title)
    await card(page, title).getByRole('textbox', { name: 'Status note' }).fill('Waiting on the certificate')
    await card(page, title).getByRole('button', { name: 'Save note' }).click()
    await expect(card(page, title).getByRole('button', { name: 'Save note' })).toBeDisabled()
    await openView(page, 'goals')
    await expect(card(page, title)).toContainText('Waiting on the certificate')
  })

  test('linking a project gives the goal open work and progress, and unlinking takes it away', async ({ page, request }, testInfo) => {
    const title = await createGoal(request, testInfo, 'link project')
    await openView(page, 'goals')
    await expect(card(page, title)).toContainText('Stalled: no open task')
    await openDetails(page, title)
    await card(page, title).getByRole('combobox', { name: 'Link a project' }).selectOption({ label: 'UI Test Project' })
    const linked = page.getByRole('region', { name: `Projects linked to ${title}` })
    await expect(linked).toContainText('UI Test Project')
    await expect(card(page, title)).not.toContainText('Stalled')
    await expect(card(page, title).getByRole('progressbar')).toHaveAttribute('aria-valuetext', /of 1 done/)

    await linked.getByRole('button', { name: 'Unlink project UI Test Project' }).click()
    await expect(linked).toContainText('None yet.')
    await expect(card(page, title)).toContainText('Stalled: no open task')
  })

  test('a task is linked by searching for part of its name', async ({ page, request }, testInfo) => {
    const title = await createGoal(request, testInfo, 'link task')
    await openView(page, 'goals')
    await openDetails(page, title)
    await card(page, title).getByRole('textbox', { name: 'Link a task' }).fill('Renew domain')
    await card(page, title).getByRole('button', { name: 'Link task Renew domain for the portfolio site' }).click()
    const linked = page.getByRole('region', { name: `Tasks linked to ${title}` })
    await expect(linked).toContainText('Renew domain for the portfolio site')
    await expect(card(page, title).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '0 of 1 done (0%)')
  })

  test('a typed-in goal updates its progress from the numbers', async ({ page, request }, testInfo) => {
    const title = await createGoal(request, testInfo, 'manual', { progressMode: 'manual', currentValue: 0, targetValue: 200, unit: 'posts' })
    await openView(page, 'goals')
    await openDetails(page, title)
    await card(page, title).getByRole('spinbutton', { name: 'Current (posts)' }).fill('50')
    await card(page, title).getByRole('button', { name: 'Save progress' }).click()
    await expect(card(page, title).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '50 of 200 posts (25%)')
  })

  test('a sub-goal is listed directly under its parent', async ({ page, request }, testInfo) => {
    const parent = await createGoal(request, testInfo, 'parent')
    const child = `${parent} child`
    await openView(page, 'goals')
    await openDetails(page, parent)
    await card(page, parent).getByRole('button', { name: 'Add sub-goal' }).click()
    const form = page.getByRole('form', { name: `New sub-goal of ${parent}` })
    await form.getByRole('textbox').first().fill(child)
    await form.getByRole('button', { name: 'Add sub-goal' }).click()
    await expect(card(page, child)).toBeVisible()
    const order = await page.getByRole('article').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
    expect(order.indexOf(child)).toBe(order.indexOf(parent) + 1)
  })

  test('Delete asks first, then removes the goal', async ({ page, request }, testInfo) => {
    const title = await createGoal(request, testInfo, 'delete')
    await openView(page, 'goals')
    await openDetails(page, title)
    await card(page, title).getByRole('button', { name: 'Delete goal', exact: true }).click()
    await expect(card(page, title)).toBeVisible()
    await card(page, title).getByRole('button', { name: 'Delete goal?' }).click()
    await expect(card(page, title)).toHaveCount(0)
  })

  test('an achieved goal leaves the list and comes back with Show achieved and dropped', async ({ page, request }, testInfo) => {
    const title = await createGoal(request, testInfo, 'achieved', { status: 'achieved' })
    await openView(page, 'goals')
    await expect(card(page, title)).toHaveCount(0)
    const toggle = page.getByRole('button', { name: 'Show achieved and dropped' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(card(page, title)).toBeVisible()
    // A closed goal is never nagged about.
    await expect(card(page, title)).not.toContainText('Stalled')
  })

  test('the vision statement is saved for every device', async ({ page }, testInfo) => {
    const text = `Ship open tools people can use with one hand (${testInfo.project.name})`
    await openView(page, 'goals')
    await page.getByRole('region', { name: 'Vision' }).getByRole('button', { name: /^(Write|Edit) vision$/ }).click()
    await page.getByRole('textbox', { name: 'Vision' }).fill(text)
    await page.getByRole('button', { name: 'Save vision' }).click()
    await openView(page, 'goals')
    await expect(page.getByRole('region', { name: 'Vision' })).toContainText(text)
  })

  test('goals left in this browser by the old tab are not offered for import once the server has goals', async ({ page }) => {
    await openView(page, 'goals')
    await page.evaluate(() => {
      localStorage.setItem('constellation-v2', JSON.stringify({ goals: { vision: 'Old vision', annual: ['Old annual goal'], quarterly: '', milestones: [] } }))
      localStorage.removeItem('cc-goals-imported-v1')
    })
    await page.reload()
    await expect(card(page, 'Ship the UI test project')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Import goals from this browser' })).toHaveCount(0)
  })

  test('every control is a 44px target and the page never scrolls sideways, with details open', async ({ page }) => {
    await openView(page, 'goals')
    await openDetails(page, 'Ship the UI test project')
    expect(await smallTargets(page.locator('main'), 'button, select')).toEqual([])
    await card(page, 'Ship the UI test project').getByRole('button', { name: /^Status of/ }).click()
    expect(await smallTargets(page.getByRole('menu'), '[role="menuitemcheckbox"]')).toEqual([])
    await page.keyboard.press('Escape')
    await expectNoHorizontalOverflow(page)
  })
})
