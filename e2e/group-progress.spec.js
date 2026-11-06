import { test, expect } from './fixtures.js'
import { openView, createTask } from './support.js'

// The Today group's header counts what is left and what is done (TaskGroupSection.jsx).
const todayHeader = (page) => page.locator('[data-reorder-group="today"]')
const leftCount = async (page) => Number(/(\d+) left/.exec(await todayHeader(page).innerText())?.[1] ?? NaN)

test.describe('Today progress', { tag: ['@flow'] }, () => {
  test('completing a task due today lowers "left" and shows how many are done', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'progress')
    await openView(page)
    await expect(todayHeader(page).getByText(/\d+ left/)).toBeVisible()
    const before = await leftCount(page)
    expect(before).toBeGreaterThan(0)

    await page.getByRole('checkbox', { name: `Complete ${title}` }).click()
    await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toHaveCount(0)

    await expect(todayHeader(page).getByText(`${before - 1} left`).or(todayHeader(page).getByText('All clear'))).toBeVisible()
    await expect(todayHeader(page).getByText(/^\d+ done$/)).toBeVisible()
    const done = Number(/(\d+) done/.exec(await todayHeader(page).innerText())?.[1] ?? NaN)
    expect(done).toBeGreaterThanOrEqual(1)
    // Numbers only: there is no bar.
    await expect(page.getByRole('progressbar')).toHaveCount(0)
  })
})
