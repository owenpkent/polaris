import { test, expect } from './fixtures.js'
import { openView, isPhone, expectNoHorizontalOverflow, smallTargets, listTaskTitles } from './support.js'

// Phase 3 chat panel mockup. The point of these tests is the contract the real panel must keep:
// it is opt-in, Esc closes it, changes are proposals, and nothing is written without a click
// (in the mockup, nothing is written at all).

test.describe('chat panel mockup', { tag: ['@flow'] }, () => {
  test('there is no chat button unless the URL asks for the mockup', async ({ page }) => {
    await openView(page)
    await expect(page.getByRole('button', { name: 'Ask Polaris' })).toHaveCount(0)
  })

  test('the top bar button opens the panel, and Esc closes it and returns focus', async ({ page }) => {
    await openView(page, 'mytasks', 'chat=mockup')
    const button = page.getByRole('button', { name: 'Ask Polaris' })
    await button.click()
    await expect(page.getByRole('dialog', { name: 'Ask Polaris' })).toBeVisible()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Ask Polaris' })).toHaveCount(0)
    await expect(button).toBeFocused()
  })

  test('a suggested question answers with task rows in one click', async ({ page }) => {
    await openView(page, 'mytasks', 'chat=mockup&open=1')
    const panel = page.getByRole('dialog', { name: 'Ask Polaris' })
    await panel.getByRole('button', { name: 'What is overdue for the studio?' }).click()
    await expect(panel).toContainText('3 overdue tasks in studio projects')
    await expect(panel.getByRole('button', { name: /^Open / })).toHaveCount(3)
    await expect(panel.getByRole('button', { name: /^Apply/ })).toHaveCount(0)
  })

  test('a change comes back as a proposal, and Apply sends nothing to the server', async ({ page, request }) => {
    const before = await listTaskTitles(request)
    await openView(page, 'mytasks', 'chat=mockup&open=1')
    const writes = []
    page.on('request', (req) => {
      if (req.method() !== 'GET') writes.push(`${req.method()} ${req.url()}`)
    })
    const panel = page.getByRole('dialog', { name: 'Ask Polaris' })
    await panel.getByRole('button', { name: 'Move everything from the client email to Friday' }).click()
    await expect(panel.getByRole('button', { name: 'Apply to 3 tasks' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Discard' })).toBeVisible()
    // Gmail-sourced tasks show structured fields only: the third-party title is withheld.
    await expect(panel.getByRole('button', { name: 'Open Task from Gmail (open to read)' })).toHaveCount(3)
    await panel.getByRole('button', { name: 'Apply to 3 tasks' }).click()
    await expect(panel).toContainText('nothing was written')
    expect(writes).toEqual([])
    expect(await listTaskTitles(request)).toEqual(before)
  })

  test('Discard drops the proposal', async ({ page }) => {
    await openView(page, 'mytasks', 'chat=mockup&open=1')
    const panel = page.getByRole('dialog', { name: 'Ask Polaris' })
    await panel.getByRole('button', { name: 'Move everything from the client email to Friday' }).click()
    await panel.getByRole('button', { name: 'Discard' }).click()
    await expect(panel).toContainText('Discarded. Nothing was changed.')
    await expect(panel.getByRole('button', { name: 'Apply to 3 tasks' })).toHaveCount(0)
  })

  test('a typed question is answered on Enter', async ({ page }) => {
    await openView(page, 'mytasks', 'chat=mockup&open=1')
    const panel = page.getByRole('dialog', { name: 'Ask Polaris' })
    const box = panel.getByRole('textbox', { name: 'Question' })
    await box.fill('what is due this week')
    await box.press('Enter')
    await expect(panel).toContainText('2 tasks due this week')
    await expect(box).toHaveValue('')
  })

  test('every control in the panel is a 44px target and the page does not scroll sideways', async ({ page }) => {
    await openView(page, 'mytasks', 'chat=mockup&open=1')
    const panel = page.getByRole('dialog', { name: 'Ask Polaris' })
    await panel.getByRole('button', { name: 'Move everything from the client email to Friday' }).click()
    expect(await smallTargets(panel, 'button')).toEqual([])
    await expectNoHorizontalOverflow(page)
  })

  test('on desktop the task list stays fully visible beside the panel', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'the panel covers the full width on a phone by design')
    await openView(page, 'mytasks', 'chat=mockup&open=1')
    const panelBox = await page.getByRole('dialog', { name: 'Ask Polaris' }).boundingBox()
    const listBox = await page.getByRole('toolbar', { name: 'Tasks' }).boundingBox()
    const lastHeader = await page.getByRole('button', { name: 'Source column menu' }).boundingBox()
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(panelBox.x)
    expect(lastHeader.x + lastHeader.width).toBeLessThanOrEqual(panelBox.x)
  })

  test('on a phone the panel covers the full width', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only')
    await openView(page, 'mytasks', 'chat=mockup&open=1')
    const box = await page.getByRole('dialog', { name: 'Ask Polaris' }).boundingBox()
    expect(Math.round(box.width)).toBe(390)
  })
})
