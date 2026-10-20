import { test, expect } from './fixtures.js'
import { TOKEN } from './global-setup.js'
import { createTask, isPhone, openTask, openView } from './support.js'

// Due times: optional, stored as floating local time ('YYYY-MM-DDTHH:MM'), set and cleared in
// the due date menu, the task panel's Due date field, and "When is it due?" for a new task.

async function taskByTitle(request, title) {
  const res = await request.get('/api/tasks', { headers: { Authorization: `Bearer ${TOKEN}` } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).tasks.find((t) => t.title === title)
}

// A YYYY-MM-DD day as MonthCalendar.jsx names its button ("Tuesday, October 20, 2026").
function dayName(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function shiftDay(iso, days) {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test.describe('due times', { tag: ['@flow'] }, () => {
  test('the task panel sets a time on the due date, shows it, keeps it through a new day, and removes it', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'due time panel')
    const day = (await taskByTitle(request, title)).dueAt
    await openView(page)
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })

    await panel.getByRole('button', { name: /^Due date, / }).click()
    const menu = page.getByRole('dialog', { name: 'Due date', exact: true })
    await menu.getByRole('button', { name: 'Add time' }).click()
    const time = menu.getByLabel('Time', { exact: true })
    await expect(time).toBeFocused()
    await time.fill('09:30')
    await time.press('Enter')
    await expect(menu).toBeHidden()
    await expect(panel.getByRole('button', { name: /^Due date, / })).toHaveAccessibleName(/^Due date, Today 9:30\sAM$/)
    await expect.poll(async () => (await taskByTitle(request, title)).dueAt).toBe(`${day}T09:30`)

    // A quick pick moves the day and keeps the time.
    await panel.getByRole('button', { name: /^Due date, / }).click()
    await menu.getByRole('button', { name: 'Tomorrow', exact: true }).click()
    await expect(panel.getByRole('button', { name: /^Due date, / })).toHaveAccessibleName(/^Due date, Tomorrow 9:30\sAM$/)
    await expect.poll(async () => (await taskByTitle(request, title)).dueAt).toMatch(/T09:30$/)

    await panel.getByRole('button', { name: /^Due date, / }).click()
    await menu.getByRole('button', { name: 'Remove time' }).click()
    await expect(panel.getByRole('button', { name: /^Due date, / })).toHaveAccessibleName('Due date, Tomorrow')
    await expect.poll(async () => (await taskByTitle(request, title)).dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('a time typed in the menu goes with a quick pick, and a half-typed time saves nothing', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'due time typed')
    await openView(page)
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    const menu = page.getByRole('dialog', { name: 'Due date', exact: true })

    await panel.getByRole('button', { name: /^Due date, / }).click()
    await menu.getByRole('button', { name: 'Add time' }).click()
    await menu.getByLabel('Time', { exact: true }).fill('08:15')
    await menu.getByRole('button', { name: 'Tomorrow', exact: true }).click()
    await expect(panel.getByRole('button', { name: /^Due date, / })).toHaveAccessibleName(/^Due date, Tomorrow 8:15\sAM$/)
    await expect.poll(async () => (await taskByTitle(request, title)).dueAt).toMatch(/T08:15$/)
    const saved = (await taskByTitle(request, title)).dueAt

    // Backspace clears one segment of the time box; Chromium then reports the box as empty.
    await panel.getByRole('button', { name: /^Due date, / }).click()
    const time = menu.getByLabel('Time', { exact: true })
    await time.click()
    await time.press('Backspace')
    await time.press('Enter')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    expect((await taskByTitle(request, title)).dueAt).toBe(saved)
  })

  test('the list cell opens on the month, where one tap on a day saves it and keeps the time', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'due time cell')
    const day = (await taskByTitle(request, title)).dueAt
    await request.patch(`/api/tasks/${(await taskByTitle(request, title)).id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      data: { dueAt: `${day}T16:45` },
    })
    await openView(page)
    const cell = page.getByRole('button', { name: `Change due date for ${title}` })
    await expect(cell).toHaveText(/^Today\s?4:45\sPM$/)
    await cell.click()
    const menu = page.getByRole('dialog', { name: `Due date for ${title}` })
    // The task's day is chosen and has focus, so Enter keeps it.
    const taskDay = menu.getByRole('button', { name: dayName(day), exact: true })
    await expect(taskDay).toHaveAttribute('aria-pressed', 'true')
    await expect(taskDay).toBeFocused()
    await menu.getByRole('button', { name: 'Tomorrow', exact: true }).click()
    await expect(cell).toHaveText(/^Tomorrow\s?4:45\sPM$/)

    // A day of the month, three days on, chosen with one tap.
    const later = shiftDay(day, 3)
    await cell.click()
    if (later.slice(0, 7) !== day.slice(0, 7)) await menu.getByRole('button', { name: 'Next month' }).click()
    await menu.getByRole('button', { name: dayName(later), exact: true }).click()
    await expect(menu).toBeHidden()
    await expect.poll(async () => (await taskByTitle(request, title)).dueAt).toBe(`${later}T16:45`)
  })

  test('a new task gets a time from Add time in "When is it due?"', async ({ page, request }, testInfo) => {
    const title = `UI test due time add ${testInfo.project.name}`
    await openView(page)
    let scope
    if (isPhone(testInfo)) {
      await page.getByRole('button', { name: 'New task' }).click()
      scope = page.getByRole('dialog', { name: 'New task' })
      await scope.getByRole('textbox', { name: 'New task name' }).fill(title)
      await scope.getByRole('textbox', { name: 'New task name' }).press('Enter')
    } else {
      await page.getByRole('button', { name: 'Add task' }).first().click()
      await page.getByRole('textbox', { name: 'New task name' }).fill(title)
      await page.getByRole('button', { name: /^Due date(: .+)?$/ }).click()
      scope = page.getByRole('dialog', { name: `Due date for ${title}` })
    }
    await scope.getByRole('button', { name: 'Add time' }).click()
    const time = scope.getByLabel('Time', { exact: true })
    await expect(time).toBeFocused()
    await time.fill('07:15')
    await scope.getByRole('button', { name: 'Tomorrow', exact: true }).click()
    await scope.getByRole('button', { name: isPhone(testInfo) ? 'Done' : 'Add task' }).click()
    if (isPhone(testInfo)) {
      await expect(scope.getByRole('button', { name: /7:15\sAM$/ })).toBeVisible()
      await scope.getByRole('button', { name: 'Create' }).click()
    }
    await expect(page.getByRole('button', { name: `Change due date for ${title}` })).toHaveText(/^Tomorrow\s?7:15\sAM$/)
    expect((await taskByTitle(request, title)).dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T07:15$/)
  })
})
