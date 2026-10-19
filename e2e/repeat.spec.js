import { test, expect } from './fixtures.js'
import { openView, createTask, openTask, smallTargets } from './support.js'
import { TOKEN } from './global-setup.js'

const auth = { Authorization: `Bearer ${TOKEN}` }

async function taskByTitle(request, title) {
  const res = await request.get('/api/tasks', { headers: auth })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).tasks.find((t) => t.title === title)
}

// The task panel's Repeat menu (quick picks worded from the due date) and its custom builder
// (Ends, and "Next one counts from"), driven as the owner would, with what reaches the server read
// back over the API. 2026-10-14 is a Wednesday, the second of its month.
test.describe('Repeating tasks', { tag: ['@flow'] }, () => {
  test('the Repeat menu offers quick picks from the due date and saves the one picked', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'repeat picks', { dueAt: '2026-10-14' })
    // Overdue, so its group is open on My tasks.
    await openView(page)
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('button', { name: 'Repeat, never' }).click()
    const menu = page.getByRole('menu', { name: 'Repeat' })
    for (const name of ['Does not repeat', 'Every weekday (Monday to Friday)', 'Weekends', 'Weekly on Wednesday', 'Every 2 weeks on Wednesday',
      'Monthly on day 14', 'Monthly on the second Wednesday', 'Every 3 months on day 14', 'Annually on October 14', 'Custom']) {
      await expect(menu.getByRole('menuitemradio', { name, exact: true })).toBeVisible()
    }
    await menu.getByRole('menuitemradio', { name: 'Monthly on the second Wednesday' }).click()
    await expect(panel.getByRole('button', { name: 'Repeat, monthly on the second Wednesday' })).toBeVisible()
    await expect.poll(async () => (await taskByTitle(request, title)).recurrence).toBe('FREQ=MONTHLY;BYDAY=2WE')
  })

  test('the due date picker sets a repeat, tints its next dates, and moves it with a new day', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'repeat in picker', { dueAt: '2026-10-14' })
    await openView(page)
    await page.getByRole('button', { name: `Change due date for ${title}` }).click()
    const picker = page.getByRole('dialog', { name: `Due date for ${title}` })
    await picker.getByLabel('Repeats', { exact: true }).selectOption('weekly')
    await expect.poll(async () => (await taskByTitle(request, title)).recurrence).toBe('FREQ=WEEKLY;BYDAY=WE')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Wednesday, October 21, 2026, repeats', exact: true })).toBeVisible()
    await picker.getByRole('button', { name: 'Friday, October 16, 2026', exact: true }).click()
    await expect(picker).toBeHidden()
    await expect.poll(async () => {
      const task = await taskByTitle(request, title)
      return [task.dueAt, task.recurrence]
    }).toEqual(['2026-10-16', 'FREQ=WEEKLY;BYDAY=FR'])
  })

  test('a repeat picked in the panel\'s due date picker on a task with no date gives it today', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'repeat no date', { dueAt: null })
    await openView(page)
    await page.getByRole('button', { name: 'Expand No due date' }).click()
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('button', { name: 'Due date, none' }).click()
    const picker = page.getByRole('dialog', { name: 'Due date', exact: true })
    await picker.getByLabel('Repeats', { exact: true }).selectOption('daily')
    await expect(panel.getByRole('button', { name: /^Due date, / })).toHaveAccessibleName('Due date, Today')
    await expect(panel.getByRole('button', { name: /^Repeat, / })).toHaveAccessibleName('Repeat, daily')
    const task = await taskByTitle(request, title)
    expect(task.recurrence).toBe('daily')
    expect(task.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('Custom sets an end and counts from the finish, and completing it counts down', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'repeat ends', { recurrence: 'weekly' })
    await openView(page)
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('button', { name: /^Repeat, weekly/ }).click()
    await page.getByRole('menuitemradio', { name: 'Custom' }).click()
    const builder = page.getByRole('group', { name: 'Custom repeat' })
    expect(await smallTargets(builder, 'button, select, input[type="date"]')).toEqual([])

    await builder.getByRole('radio', { name: 'The day I finish it' }).check()
    await expect(builder.getByText('Each one is due a week after the day you finish the one before.')).toBeVisible()
    await expect(builder.getByRole('button', { name: 'Monday' })).toHaveCount(0)
    await builder.getByRole('combobox', { name: 'Number of times' }).selectOption('3')
    await expect(builder.getByRole('radio', { name: /^After/ })).toBeChecked()
    await builder.getByRole('button', { name: 'Save' }).click()

    await expect(panel.getByRole('button', { name: 'Repeat, weekly after you finish it, 2 more after this' })).toBeVisible()
    await expect(panel.getByText(/^Counted from the day you finish it\. Skipping moves it to /)).toBeVisible()
    const task = await taskByTitle(request, title)
    expect(task.recurrence).toBe('FREQ=WEEKLY;COUNT=3;X-FROM=COMPLETION')

    const res = await request.post(`/api/tasks/${task.id}/complete`, { headers: auth })
    expect(res.ok()).toBeTruthy()
    expect((await res.json()).next.recurrence).toBe('FREQ=WEEKLY;COUNT=2;X-FROM=COMPLETION')
  })

  test('Ends is reached and changed from the keyboard', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'repeat keys', { recurrence: 'daily' })
    await openView(page)
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('button', { name: /^Repeat, daily/ }).click()
    await page.getByRole('menuitemradio', { name: 'Custom' }).click()
    const builder = page.getByRole('group', { name: 'Custom repeat' })
    const never = builder.getByRole('radio', { name: 'Never' })
    await never.focus()
    await page.keyboard.press('ArrowDown')
    await expect(builder.getByRole('radio', { name: /^On/ })).toBeChecked()
    await expect(builder.getByRole('radio', { name: /^On/ })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(builder.getByLabel('End date')).toBeFocused()
    await builder.getByLabel('End date').fill('2026-12-31')
    await builder.getByRole('button', { name: 'Save' }).click()
    await expect(panel.getByRole('button', { name: 'Repeat, daily, until Dec 31, 2026' })).toBeVisible()
    expect((await taskByTitle(request, title)).recurrence).toBe('FREQ=DAILY;UNTIL=20261231')
  })
})
