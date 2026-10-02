import { test, expect } from './fixtures.js'
import { openView, isPhone, createTask, createGoal, listTaskTitles, openTask, smallTargets } from './support.js'
import { TOKEN } from './global-setup.js'

const row = (page, title) => page.getByRole('button', { name: `Open ${title}`, exact: true })

test.describe('My tasks', { tag: ['@flow'] }, () => {
  test('groups the seeded tasks by due date', async ({ page }) => {
    await openView(page)
    await expect(row(page, 'Renew domain for the portfolio site')).toBeVisible()
    await expect(row(page, 'Reply to accessibility audit feedback')).toBeVisible()
    await expect(row(page, 'Draft ADR-003 hosting options')).toBeVisible()
    await expect(row(page, 'Clean up stale branches across repos')).toBeVisible()
    for (const group of ['Overdue', 'Today', 'Tomorrow', 'Next 7 days']) {
      await expect(page.getByRole('button', { name: `Collapse ${group}` })).toBeVisible()
    }
    // Later and No due date start collapsed, so their rows are not rendered yet.
    await expect(page.getByRole('button', { name: 'Expand Later' })).toBeVisible()
    await expect(row(page, 'Plan next marketing post')).toHaveCount(0)
  })

  test('a collapsed group expands on click and collapses again', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Expand Later' }).click()
    await expect(row(page, 'Plan next marketing post')).toBeVisible()
    await page.getByRole('button', { name: 'Collapse Later' }).click()
    await expect(row(page, 'Plan next marketing post')).toHaveCount(0)
  })

  test('due cells read Today and Tomorrow for those days and a date for overdue tasks', async ({ page }) => {
    await openView(page)
    await expect(page.getByRole('button', { name: 'Change due date for Reply to accessibility audit feedback' })).toHaveText('Today')
    await expect(page.getByRole('button', { name: 'Change due date for Draft ADR-003 hosting options' })).toHaveText('Tomorrow')
    await expect(page.getByRole('button', { name: 'Change due date for Renew domain for the portfolio site' })).not.toHaveText(/Today|Tomorrow/)
  })

  test('Add task creates a task from the keyboard and shows it in the list', async ({ page, request }, testInfo) => {
    const title = `UI test typed ${testInfo.project.name}`
    await openView(page)
    await page.getByRole('button', { name: 'Add task' }).first().click()
    const input = page.getByRole('textbox', { name: 'New task name' })
    await expect(input).toBeFocused()
    await input.fill(title)
    await input.press('Enter')
    await expect(row(page, title)).toBeVisible()
    expect(await listTaskTitles(request)).toContain(title)
  })

  test('Esc cancels Add task without creating anything', async ({ page, request }) => {
    await openView(page)
    const before = (await listTaskTitles(request)).length
    await page.getByRole('button', { name: 'Add task' }).first().click()
    const input = page.getByRole('textbox', { name: 'New task name' })
    await input.fill('Should never exist')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    expect((await listTaskTitles(request)).length).toBe(before)
  })

  test('on a phone, Add task opens a sheet that creates with a due date and a project', async ({ page, request }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only')
    const title = `UI test sheet ${testInfo.project.name}`
    await openView(page)
    await page.getByRole('button', { name: 'New task' }).click()
    const sheet = page.getByRole('dialog', { name: 'New task' })
    await expect(sheet).toBeVisible()
    expect(await smallTargets(sheet, 'button, select, input:not([type="date"])')).toEqual([])
    await sheet.getByRole('textbox', { name: 'New task name' }).fill(title)
    await sheet.getByRole('button', { name: 'Tomorrow', exact: true }).click()
    await sheet.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'UI Test Project' })
    await sheet.getByRole('button', { name: 'Create' }).click()
    await expect(sheet).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New task' })).toBeFocused()
    await expect(page.getByRole('button', { name: `Change due date for ${title}` })).toHaveText('Tomorrow')
    const res = await request.get('/api/tasks', { headers: { Authorization: `Bearer ${TOKEN}` } })
    const created = (await res.json()).tasks.find((t) => t.title === title)
    expect(created.projectId).toBeTruthy()
  })

  test('on a phone, a task created with the default No date, or a date in Later, is shown', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only')
    // Both groups start collapsed (DEFAULT_COLLAPSED in MyTasksTab.jsx): the new task's group
    // opens, or a good save looks like a failed one.
    await openView(page)
    await expect(page.getByRole('button', { name: 'Expand Later' })).toBeVisible()
    const sheet = page.getByRole('dialog', { name: 'New task' })

    const noDate = `UI test default date ${testInfo.project.name}`
    await page.getByRole('button', { name: 'New task' }).click()
    await sheet.getByRole('textbox', { name: 'New task name' }).fill(noDate)
    await sheet.getByRole('button', { name: 'Create' }).click()
    await expect(sheet).toHaveCount(0)
    await expect(row(page, noDate)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Collapse No due date' })).toBeVisible()

    const later = `UI test later date ${testInfo.project.name}`
    await page.getByRole('button', { name: 'New task' }).click()
    await sheet.getByRole('textbox', { name: 'New task name' }).fill(later)
    await sheet.getByLabel('Other date').fill('2031-01-15')
    await sheet.getByRole('button', { name: 'Create' }).click()
    await expect(sheet).toHaveCount(0)
    await expect(row(page, later)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Collapse Later' })).toBeVisible()
  })

  test('on a phone, an open sheet keeps its draft when the viewport turns to landscape and back', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only')
    await openView(page)
    await page.getByRole('button', { name: 'New task' }).click()
    const sheet = page.getByRole('dialog', { name: 'New task' })
    await sheet.getByRole('textbox', { name: 'New task name' }).fill('UI test rotated draft')
    await sheet.getByRole('textbox', { name: 'Notes' }).fill('kept across the breakpoint')
    await sheet.getByRole('button', { name: 'Tomorrow', exact: true }).click()
    await sheet.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'UI Test Project' })

    await page.setViewportSize({ width: 844, height: 390 })
    await expect(sheet).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })

    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('textbox', { name: 'New task name' })).toHaveValue('UI test rotated draft')
    await expect(sheet.getByRole('textbox', { name: 'Notes' })).toHaveValue('kept across the breakpoint')
    await expect(sheet.getByRole('button', { name: 'Tomorrow', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await sheet.getByRole('combobox', { name: 'Project' }).evaluate((el) => el.selectedOptions[0].label)).toBe('UI Test Project')
    await sheet.getByRole('button', { name: 'Close new task' }).click()
    await expect(sheet).toHaveCount(0)
  })

  test('ticking the checkbox completes the task and it stays gone after a reload', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'complete')
    await openView(page)
    await page.getByRole('checkbox', { name: `Complete ${title}` }).click()
    await expect(row(page, title)).toHaveCount(0)
    await openView(page)
    await expect(row(page, title)).toHaveCount(0)
  })

  test('sorting by name descending reorders rows inside a group', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Sort' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Name (descending)' }).click()
    await page.keyboard.press('Escape')
    await expect(row(page, 'Review dashboard focus ring contrast')).toBeVisible()
    const labels = await page
      .getByRole('button', { name: /^Open Re(ply to accessibility|view dashboard)/ })
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
    expect(labels).toEqual(['Open Review dashboard focus ring contrast', 'Open Reply to accessibility audit feedback'])
  })

  test('filtering by Urgent leaves only urgent tasks and Clear filters restores the rest', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Filter' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Urgent' }).click()
    await expect(row(page, 'Reply to accessibility audit feedback')).toBeVisible()
    await expect(row(page, 'Renew domain for the portfolio site')).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await page.keyboard.press('Escape')
    await expect(row(page, 'Renew domain for the portfolio site')).toBeVisible()
  })

  test('a task linked to a goal from its panel is what the Goal filter leaves', async ({ page, request }, testInfo) => {
    const goal = await createGoal(request, testInfo, 'moves')
    const title = await createTask(request, testInfo, 'linked')
    await openView(page)
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('button', { name: 'Add to goal' }).click()
    await page.getByRole('menuitem', { name: goal }).click()
    await expect(panel.getByRole('button', { name: `Remove from goal ${goal}` })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)

    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: goal }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Filter (1)' })).toBeVisible()
    await expect(row(page, title)).toBeVisible()
    await expect(row(page, 'Renew domain for the portfolio site')).toHaveCount(0)

    // Removing the link takes the task out of the filtered list.
    await openTask(page, title)
    await panel.getByRole('button', { name: `Remove from goal ${goal}` }).click()
    await expect(panel.getByRole('button', { name: `Remove from goal ${goal}` })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(row(page, title)).toHaveCount(0)
  })

  // The seed makes "Assemble the standing desk" depend on "Choose a standing desk". Blocked and
  // Ready are the server's views of those names, so the two filters split the pair, and the panel
  // of the held task names what holds it.
  test('Blocked leaves the held task, whose panel names its blocker, and Ready leaves the blocker', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Blocked' }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Filter (1)' })).toBeVisible()
    await expect(row(page, 'Assemble the standing desk')).toBeVisible()
    await expect(row(page, 'Choose a standing desk')).toHaveCount(0)
    await expect(row(page, 'Reply to accessibility audit feedback')).toHaveCount(0)

    await openTask(page, 'Assemble the standing desk')
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('button', { name: 'More details' }).click()
    await expect(panel.getByText('Blocked by')).toBeVisible()
    await expect(panel.getByRole('button', { name: /Choose a standing desk/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)

    await page.getByRole('button', { name: 'Filter (1)' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Blocked' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Ready' }).click()
    await page.keyboard.press('Escape')
    await expect(row(page, 'Choose a standing desk')).toBeVisible()
    await expect(row(page, 'Reply to accessibility audit feedback')).toBeVisible()
    await expect(row(page, 'Assemble the standing desk')).toHaveCount(0)

    await page.getByRole('button', { name: 'Filter (1)' }).click()
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await page.keyboard.press('Escape')
    await expect(row(page, 'Assemble the standing desk')).toBeVisible()
  })

  test('the sort menu closes on Esc', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Sort' }).click()
    await expect(page.getByRole('menu', { name: 'Sort tasks' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Sort tasks' })).toHaveCount(0)
  })

  test('priority changes from the row menu and survives a reload', async ({ page, request }, testInfo) => {
    test.skip(isPhone(testInfo), 'the phone tier shows only Name and Due date')
    const title = await createTask(request, testInfo, 'priority')
    await openView(page)
    await page.getByRole('button', { name: `Change priority for ${title}` }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Urgent' }).click()
    await expect(page.getByRole('button', { name: `Change priority for ${title}` })).toHaveText('Urgent')
    await openView(page)
    await expect(page.getByRole('button', { name: `Change priority for ${title}` })).toHaveText('Urgent')
  })

  test('the phone tier shows Name and Due date only, and hides Columns', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only')
    await openView(page)
    await expect(page.getByRole('button', { name: 'Name column menu' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Due date column menu' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Priority column menu' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Columns' })).toBeHidden()
  })
})

test.describe('task details panel', { tag: ['@flow'] }, () => {
  test('opens from a row, closes on Esc, and returns focus to that row', async ({ page }) => {
    await openView(page)
    const target = await openTask(page, 'Reply to accessibility audit feedback')
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel.getByRole('textbox', { name: 'Task title' })).toHaveValue('Reply to accessibility audit feedback')
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(target).toBeFocused()
  })

  test('the Close button closes the panel', async ({ page }) => {
    await openView(page)
    await openTask(page, 'Draft ADR-003 hosting options')
    await page.getByRole('button', { name: 'Close task details' }).click()
    await expect(page.getByRole('dialog', { name: 'Task details' })).toHaveCount(0)
  })

  test('Tab stays inside the open panel', async ({ page }) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel).toBeVisible()
    // The panel takes focus when it opens; wait for that before the first Tab, since a Tab
    // pressed a moment earlier would move focus from the row, outside the panel.
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement)), { message: 'the panel took focus' }).toBe(true)
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab')
      const inside = await panel.evaluate((el) => el.contains(document.activeElement))
      expect(inside, `focus left the panel after ${i + 1} Tab presses`).toBe(true)
    }
  })

  test('a renamed task keeps its new title after a reload', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'rename')
    const renamed = `${title} renamed`
    await openView(page)
    await openTask(page, title)
    const field = page.getByRole('textbox', { name: 'Task title' })
    await field.fill(renamed)
    await field.press('Enter')
    await page.keyboard.press('Escape')
    await expect(row(page, renamed)).toBeVisible()
    await openView(page)
    await expect(row(page, renamed)).toBeVisible()
  })

  test('Mark complete removes the task from the list', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'panel complete')
    await openView(page)
    await openTask(page, title)
    await page.getByRole('button', { name: 'Mark complete' }).click()
    await page.keyboard.press('Escape')
    await expect(row(page, title)).toHaveCount(0)
  })
})

test.describe('task history', { tag: ['@flow'] }, () => {
  test('Put back restores the title an edit replaced', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'put back')
    const headers = { Authorization: `Bearer ${TOKEN}` }
    const list = await (await request.get('/api/tasks', { headers })).json()
    const task = list.tasks.find((t) => t.title === title)
    const renamed = `${title} renamed`
    expect((await request.patch(`/api/tasks/${task.id}`, { headers, data: { title: renamed } })).ok()).toBeTruthy()

    await openView(page)
    await openTask(page, renamed)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('button', { name: 'More details' }).click()
    await panel.getByRole('button', { name: /^Put back/ }).click()
    await expect(panel.getByRole('textbox', { name: 'Task title' })).toHaveValue(title)
  })
})
