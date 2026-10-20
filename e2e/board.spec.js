import { test, expect } from './fixtures.js'
import { openView, createTask, smallTargets, expectNoHorizontalOverflow } from './support.js'

// Board fixtures come from command-center/src/dev/seed-ui-test.ts: "UI Test Project" with a
// Backlog lane (alpha, beta) and a Doing lane (gamma). Tests that move a card create their own.

// A lane is a region labelled by its heading, so it is addressed by name like everything else.
const lane = (page, name) => page.getByRole('region', { name, exact: true })

const card = (scope, title) => scope.getByRole('button', { name: new RegExp(`^${title}`) })

async function newCard(request, testInfo, label, section = 'Backlog') {
  return createTask(request, testInfo, label, { project: 'ui-test-project', section, dueAt: null })
}

test.describe('Board', { tag: ['@flow'] }, () => {
  test('shows the project lanes with their cards', async ({ page }) => {
    await openView(page, 'board')
    await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue(/.+/)
    await expect(card(lane(page, 'Backlog'), 'Board card alpha')).toBeVisible()
    await expect(card(lane(page, 'Backlog'), 'Board card beta')).toBeVisible()
    await expect(card(lane(page, 'Doing'), 'Board card gamma')).toBeVisible()
    await expect(lane(page, 'No section')).toBeVisible()
    for (const name of ['Backlog', 'Doing', 'No section']) {
      await expect(lane(page, name).getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
    }
  })

  test('a card shows its priority, and a card without one shows none', async ({ page }) => {
    await openView(page, 'board')
    await expect(card(lane(page, 'Backlog'), 'Board card alpha')).toContainText('High')
    await expect(card(lane(page, 'Backlog'), 'Board card beta')).not.toContainText(/High|Low|Medium|Urgent/)
  })

  test('a card moves to another lane from its Move menu, with no dragging, and stays there', async ({ page, request }, testInfo) => {
    const title = await newCard(request, testInfo, 'move')
    await openView(page, 'board')
    await expect(card(lane(page, 'Backlog'), title)).toBeVisible()
    await page.getByRole('button', { name: `Move ${title}`, exact: true }).click()
    const menu = page.getByRole('menu', { name: `Move ${title}` })
    // The lane the card is already in is offered but disabled.
    await expect(menu.getByRole('menuitem', { name: 'Backlog' })).toBeDisabled()
    await menu.getByRole('menuitem', { name: 'Doing' }).click()
    await expect(card(lane(page, 'Doing'), title)).toBeVisible()
    await expect(card(lane(page, 'Backlog'), title)).toHaveCount(0)
    await openView(page, 'board')
    await expect(card(lane(page, 'Doing'), title)).toBeVisible()
  })

  test('the Move menu works from the keyboard and closes on Esc', async ({ page, request }, testInfo) => {
    const title = await newCard(request, testInfo, 'keyboard move')
    await openView(page, 'board')
    const moveButton = page.getByRole('button', { name: `Move ${title}`, exact: true })
    await moveButton.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: `Move ${title}` })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(card(lane(page, 'Backlog'), title)).toBeVisible()
  })

  test('a card can be moved out of every section', async ({ page, request }, testInfo) => {
    const title = await newCard(request, testInfo, 'unsection', 'Doing')
    await openView(page, 'board')
    await page.getByRole('button', { name: `Move ${title}`, exact: true }).click()
    await page.getByRole('menu', { name: `Move ${title}` }).getByRole('menuitem', { name: 'No section' }).click()
    await expect(card(lane(page, 'No section'), title)).toBeVisible()
  })

  test('a card completes from its check circle by keyboard, files under Show done, and reopens', async ({ page, request }, testInfo) => {
    const title = await newCard(request, testInfo, 'complete')
    await openView(page, 'board')
    const backlog = lane(page, 'Backlog')
    await backlog.getByRole('checkbox', { name: `Complete ${title}`, exact: true }).focus()
    await page.keyboard.press('Space')
    await expect(card(backlog, title)).toHaveCount(0)
    await backlog.getByRole('button', { name: /^Show \d+ done$/ }).click()
    const reopen = backlog.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })
    await expect(reopen).toBeChecked()
    await reopen.click()
    await expect(backlog.getByRole('checkbox', { name: `Complete ${title}`, exact: true })).not.toBeChecked()
  })

  test("a lane's Add task puts a new card in that lane and stays open for the next", async ({ page }, testInfo) => {
    const title = `UI test board add ${testInfo.project.name} ${Date.now()}`
    await openView(page, 'board')
    const doing = lane(page, 'Doing')
    await doing.getByRole('button', { name: 'Add task to Doing', exact: true }).click()
    const box = doing.getByRole('textbox', { name: 'New task in Doing' })
    await expect(box).toBeFocused()
    await box.fill(title)
    await page.keyboard.press('Enter')
    await expect(card(doing, title)).toBeVisible()
    await expect(box).toHaveValue('')
    await expect(box).toBeFocused()
    expect(await smallTargets(doing, 'button')).toEqual([])
    await page.keyboard.press('Escape')
    await expect(box).toHaveCount(0)
    await expect(doing.getByRole('button', { name: 'Add task to Doing', exact: true })).toBeFocused()
    await openView(page, 'board')
    await expect(card(lane(page, 'Doing'), title)).toBeVisible()
  })

  test('clicking a card opens its details with the project and section filled in', async ({ page }) => {
    await openView(page, 'board')
    await card(lane(page, 'Doing'), 'Board card gamma').click()
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel.getByRole('textbox', { name: 'Task title' })).toHaveValue('Board card gamma')
    await expect(panel).toContainText('UI Test Project')
    await expect(panel).toContainText('Doing')
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })

  test('cards and Move buttons are 44px targets and the page does not scroll sideways', async ({ page }) => {
    await openView(page, 'board')
    await expect(card(lane(page, 'Backlog'), 'Board card alpha')).toBeVisible()
    expect(await smallTargets(page.locator('main'), 'button')).toEqual([])
    await page.getByRole('button', { name: 'Move Board card alpha', exact: true }).click()
    expect(await smallTargets(page.getByRole('menu', { name: 'Move Board card alpha' }), '[role="menuitem"]')).toEqual([])
    await page.keyboard.press('Escape')
    await expectNoHorizontalOverflow(page)
  })
})
