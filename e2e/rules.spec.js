import { test, expect } from './fixtures.js'
import { openView, smallTargets, listTaskTitles } from './support.js'
import { TOKEN } from './global-setup.js'

// The seeded rule ("Notify when a task is overdue") is saved disabled, which is how a rule made
// by an agent arrives (CLAUDE.md: rules created by an agent are saved disabled, and only the owner
// enables them). These tests never enable it, so both viewport runs see the same state.
const SEEDED = 'Notify when a task is overdue'

// One rule's card: the smallest block that holds both the rule name and a Run dry button.
const ruleCard = (page, name) =>
  page.locator('main div').filter({ hasText: name }).filter({ has: page.getByRole('button', { name: 'Run dry' }) }).last()

async function ruleByName(request, name) {
  const res = await request.get('/api/rules', { headers: { Authorization: `Bearer ${TOKEN}` } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).rules.find((r) => r.name === name)
}

test.describe('Rules', { tag: ['@flow'] }, () => {
  test('a rule that was saved disabled shows as disabled', async ({ page, request }) => {
    await openView(page, 'rules')
    await expect(page.locator('main')).toContainText(SEEDED)
    await expect(ruleCard(page, SEEDED).getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked()
    expect((await ruleByName(request, SEEDED)).enabled).toBe(false)
  })

  test('Run dry reports what the rule would do and changes nothing', async ({ page, request }) => {
    const before = await listTaskTitles(request)
    await openView(page, 'rules')
    await ruleCard(page, SEEDED).getByRole('button', { name: 'Run dry' }).click()
    await expect(page.locator('main')).toContainText('Dry run result')
    await expect(page.locator('main')).toContainText('overdue: Renew domain for the portfolio site')
    expect(await listTaskTitles(request)).toEqual(before)
    expect((await ruleByName(request, SEEDED)).enabled).toBe(false)
  })

  test('View definition shows the rule JSON', async ({ page }) => {
    await openView(page, 'rules')
    // The seeded rule is the oldest, so its definition toggle is the first one listed.
    await page.getByText('View definition').first().click()
    await expect(page.locator('main')).toContainText('"condition": "overdue"')
  })

  test('invalid JSON in the New rule form is refused and creates nothing', async ({ page, request }, testInfo) => {
    const name = `UI test broken rule ${testInfo.project.name}`
    await openView(page, 'rules')
    await page.getByRole('textbox', { name: 'Name' }).fill(name)
    await page.getByRole('textbox', { name: 'Definition (JSON)' }).fill('{ this is not json')
    await page.getByRole('button', { name: 'Create rule' }).click()
    await expect(page.locator('main')).toContainText(/json|invalid|parse/i)
    expect(await ruleByName(request, name)).toBeUndefined()
  })

  test('the owner can create a rule with Enabled unticked, and delete it again', async ({ page, request }, testInfo) => {
    const name = `UI test rule ${testInfo.project.name}`
    await openView(page, 'rules')
    await page.getByRole('textbox', { name: 'Name' }).fill(name)
    await page.getByRole('checkbox', { name: 'Enabled' }).first().uncheck()
    await page.getByRole('button', { name: 'Create rule' }).click()
    await expect(page.locator('main')).toContainText(name)
    expect((await ruleByName(request, name)).enabled).toBe(false)

    // Delete asks first: the button turns into "Delete rule?" and only that click deletes.
    const mine = ruleCard(page, name)
    await mine.getByRole('button', { name: 'Delete', exact: true }).click()
    expect(await ruleByName(request, name)).toBeDefined()
    await mine.getByRole('button', { name: 'Delete rule?' }).click()
    await expect(page.locator('main')).not.toContainText(name)
    expect(await ruleByName(request, name)).toBeUndefined()
    expect(await ruleByName(request, SEEDED)).toBeDefined()
  })

  test('rule controls are 44px targets', async ({ page }) => {
    await openView(page, 'rules')
    await expect(page.locator('main')).toContainText(SEEDED)
    expect(await smallTargets(page.locator('main'), 'button, summary')).toEqual([])
  })
})
