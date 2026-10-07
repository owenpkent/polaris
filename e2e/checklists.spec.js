import { test, expect } from './fixtures.js'
import { TOKEN } from './server.js'
import { createTask, expectNoHorizontalOverflow, openTask, openView, smallTargets } from './support.js'

// Reusable checklists: a template made once and started as often as needed. Starting one makes a
// new task with one subtask per item, and ticking an item is completing a subtask. The seeded
// "Packing: weekend trip" is only ever read here; the tests that change data make their own.

const row = (page, name) => page.getByRole('article', { name, exact: true })

let made = 0
const uniqueName = (label, testInfo) => `UI test checklist ${label} ${testInfo.project.name} ${++made}`

async function makeChecklist(page, name, items) {
  await page.getByRole('toolbar', { name: 'Checklists' }).getByRole('button', { name: 'New checklist' }).click()
  const form = page.getByRole('form', { name: 'New checklist' })
  await expect(form.getByRole('textbox', { name: 'Name' })).toBeFocused()
  await form.getByRole('textbox', { name: 'Name' }).fill(name)
  const newItem = form.getByRole('textbox', { name: 'New item' })
  for (const item of items) {
    await newItem.fill(item)
    await newItem.press('Enter')
  }
  return form
}

test.describe('Checklists', { tag: ['@flow'] }, () => {
  test('lists the seeded checklist with its item count', async ({ page }) => {
    await openView(page, 'checklists')
    await expect(row(page, 'Packing: weekend trip')).toContainText('5 items')
    await expect(row(page, 'Packing: weekend trip')).toContainText('Passport, Phone charger, Toothbrush and 2 more')
  })

  test('make a checklist, start it, and tick an item: the template is left as it was', async ({ page }, testInfo) => {
    const name = uniqueName('flow', testInfo)
    const items = [`Tent ${made}`, `Sleeping bag ${made}`, `Torch ${made}`]
    await openView(page, 'checklists')

    const form = await makeChecklist(page, name, items)
    // Torch to the top, by buttons alone.
    await form.getByRole('button', { name: 'Move item 3 up' }).click()
    await form.getByRole('button', { name: 'Move item 2 up' }).click()
    await expect(form.getByRole('textbox', { name: 'Item 1' })).toHaveValue(items[2])
    expect(await smallTargets(form)).toEqual([])
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form).toHaveCount(0)
    await expect(row(page, name)).toContainText('3 items')

    await row(page, name).getByRole('button', { name: `Start ${name}` }).click()
    const start = page.getByRole('form', { name: `Start ${name}` })
    await expect(start.getByRole('textbox', { name: 'Task title' })).toHaveValue(name)
    await start.getByRole('combobox', { name: 'Project (optional)' }).selectOption({ label: 'UI Test Project' })
    await start.getByRole('button', { name: 'Start' }).click()

    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('textbox', { name: 'Task title' })).toHaveValue(name)
    await expect(panel.getByText('0 of 3 done')).toBeVisible()
    const order = await panel.getByRole('checkbox').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
    expect(order).toEqual([`Complete ${items[2]}`, `Complete ${items[0]}`, `Complete ${items[1]}`])

    await panel.getByRole('checkbox', { name: `Complete ${items[0]}` }).click()
    await expect(panel.getByRole('checkbox', { name: `Reopen ${items[0]}` })).toHaveAttribute('aria-checked', 'true')
    await expect(panel.getByText('1 of 3 done')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: `Started ${name} with 3 items.` })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open task' })).toBeFocused()
    // Starting changed nothing on the template: still three items, ready to start again.
    await expect(row(page, name)).toContainText('3 items')
    await expect(row(page, name).getByRole('button', { name: `Start ${name}` })).toBeEnabled()
  })

  test('Esc closes the new checklist form without saving anything', async ({ page }) => {
    await openView(page, 'checklists')
    const form = await makeChecklist(page, 'Should never exist', ['Nothing'])
    await page.keyboard.press('Escape')
    await expect(form).toHaveCount(0)
    await expect(row(page, 'Should never exist')).toHaveCount(0)
    await expect(page.getByRole('toolbar', { name: 'Checklists' }).getByRole('button', { name: 'New checklist' })).toBeFocused()
  })

  test('edit an item list, then delete the checklist after a second click', async ({ page }, testInfo) => {
    const name = uniqueName('edit', testInfo)
    await openView(page, 'checklists')
    const form = await makeChecklist(page, name, ['Dishes', 'Counters', 'Floor'])
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(row(page, name)).toContainText('3 items')

    await row(page, name).getByRole('button', { name: `Edit ${name}` }).click()
    const edit = page.getByRole('form', { name: `Edit ${name}` })
    await edit.getByRole('button', { name: 'Remove item 2' }).click()
    await expect(edit.getByRole('textbox', { name: 'Item 2' })).toBeFocused()
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit).toHaveCount(0)
    await expect(row(page, name)).toContainText('2 items: Dishes, Floor')

    await row(page, name).getByRole('button', { name: `Edit ${name}` }).click()
    await edit.getByRole('button', { name: 'Delete checklist' }).click()
    await edit.getByRole('button', { name: 'Delete checklist?' }).click()
    await expect(row(page, name)).toHaveCount(0)
  })

  test('save a task with subtasks as a checklist from its panel', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'save as checklist')
    const headers = { Authorization: `Bearer ${TOKEN}` }
    const parent = (await (await request.get(`/api/tasks?text=${encodeURIComponent(title)}`, { headers })).json()).tasks[0]
    for (const sub of ['Step one', 'Step two']) {
      const res = await request.post('/api/tasks', { headers, data: { title: `${sub} ${made}`, parentId: parent.id } })
      expect(res.ok()).toBeTruthy()
    }
    await openView(page)
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('button', { name: 'Save as checklist' }).click()
    await expect(panel.getByRole('status').filter({ hasText: `Saved as the checklist "${title}"` })).toBeVisible()
    await page.keyboard.press('Escape')

    await openView(page, 'checklists')
    await expect(row(page, title)).toContainText('2 items')
  })

  test('the page and its forms fit the screen with 44px controls', async ({ page }) => {
    await openView(page, 'checklists')
    await expect(row(page, 'Packing: weekend trip')).toBeVisible()
    expect(await smallTargets(page.getByRole('main'))).toEqual([])
    await row(page, 'Packing: weekend trip').getByRole('button', { name: 'Start Packing: weekend trip' }).click()
    const start = page.getByRole('form', { name: 'Start Packing: weekend trip' })
    await expect(start.getByRole('button', { name: 'Start' })).toBeFocused()
    expect(await smallTargets(start)).toEqual([])
    await expectNoHorizontalOverflow(page)
    await page.keyboard.press('Escape')
    await expect(start).toHaveCount(0)
    await expect(row(page, 'Packing: weekend trip').getByRole('button', { name: 'Start Packing: weekend trip' })).toBeFocused()
  })
})
