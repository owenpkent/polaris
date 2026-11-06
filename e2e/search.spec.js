import { test, expect } from './fixtures.js'
import { TOKEN } from './server.js'
import { MIN_TARGET, createTask, expectFocusRing, openView, smallTargets } from './support.js'

// Search (src/command-center/SearchDialog.jsx): the top bar's Search button, or `/`, opens a
// dialog over whichever view is showing. It asks the server for tasks whose title or notes hold
// the words typed, and choosing one opens that task's panel on My tasks.

test.describe('search', { tag: ['@flow'] }, () => {
  test('finds a task by a word from its title, from another view, and opens it', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'search by title periwinkle')
    await openView(page, 'board')
    await page.getByRole('button', { name: 'Search tasks' }).click()
    const dialog = page.getByRole('dialog', { name: 'Search tasks' })
    const box = dialog.getByRole('textbox', { name: 'Search tasks' })
    await expect(box).toBeFocused()
    await box.fill('periwinkle')
    await dialog.getByRole('button', { name: title }).click()

    await expect(dialog).toHaveCount(0)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('textbox', { name: 'Task title' })).toHaveValue(title)
    await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible()
  })

  test('finds a task by its notes, and a finished one is listed as Done', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'search by notes', { notes: 'the marigold invoice' })
    const list = await request.get('/api/tasks?text=marigold', { headers: { Authorization: `Bearer ${TOKEN}` } })
    const { id } = (await list.json()).tasks.find((task) => task.title === title)
    const done = await request.post(`/api/tasks/${id}/complete`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(done.ok(), `complete failed: ${done.status()}`).toBeTruthy()

    await openView(page)
    await page.getByRole('button', { name: 'Search tasks' }).click()
    const dialog = page.getByRole('dialog', { name: 'Search tasks' })
    await dialog.getByRole('textbox', { name: 'Search tasks' }).fill('marigold')
    await expect(dialog.getByRole('button', { name: title })).toContainText('Done')
  })

  test('says when nothing matches', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Search tasks' }).click()
    const dialog = page.getByRole('dialog', { name: 'Search tasks' })
    await dialog.getByRole('textbox', { name: 'Search tasks' }).fill('zzqqxx no such task')
    await expect(dialog.getByRole('status')).toHaveText('No tasks match.')
  })

  test('Esc closes it and focus goes back to the Search button', async ({ page }) => {
    await openView(page)
    const button = page.getByRole('button', { name: 'Search tasks' })
    await button.click()
    await expect(page.getByRole('dialog', { name: 'Search tasks' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Search tasks' })).toHaveCount(0)
    await expect(button).toBeFocused()
  })

  test('the slash key opens it, and a result is reached and opened with the keyboard', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'search by keyboard heliotrope')
    await openView(page)
    await page.keyboard.press('/')
    const dialog = page.getByRole('dialog', { name: 'Search tasks' })
    await expect(dialog.getByRole('textbox', { name: 'Search tasks' })).toBeFocused()
    await page.keyboard.type('heliotrope')
    const row = dialog.getByRole('button', { name: title })
    await expect(row).toBeVisible()
    // The box, Close, then the first result.
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await expect(row).toBeFocused()
    await expectFocusRing(page)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible()
  })
})

test.describe('search targets', { tag: ['@a11y'] }, () => {
  test('the button, the box, Close, and every result are full-size targets', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'search targets cerulean')
    await openView(page)
    const button = page.getByRole('button', { name: 'Search tasks' })
    const size = await button.boundingBox()
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(MIN_TARGET)
    await button.click()
    const dialog = page.getByRole('dialog', { name: 'Search tasks' })
    await dialog.getByRole('textbox', { name: 'Search tasks' }).fill('cerulean')
    await expect(dialog.getByRole('button', { name: title })).toBeVisible()
    expect(await smallTargets(dialog, 'button, input')).toEqual([])
  })
})
