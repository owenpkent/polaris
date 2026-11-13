import { test, expect } from './fixtures.js'
import { createTask, openView, openTask, isPhone } from './support.js'
import { TOKEN } from './server.js'

// Where text starts, and at what size, must not move when a place for typing opens: a new task's
// name starts where the names above it start, a task being renamed keeps its words where they
// were, and a new subtask or Board card is typed in line with the ones already there. A shift of
// a few pixels reads as the list jumping under the pointer.

// The left edge of an element's words and their font size: for a box you type in, inside its
// border and padding; for anything else, where its first run of text is laid out.
async function textStart(locator) {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el)
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)), size: cs.fontSize }
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      return { x: Math.round(range.getBoundingClientRect().left), size: getComputedStyle(n.parentElement).fontSize }
    }
    return null
  })
}

// Within a pixel, for rounding. `size: false` for text that lines up with a heading of another size.
function expectInLine(actual, expected, what, { size = true } = {}) {
  expect(actual, `${what}: no text found`).not.toBeNull()
  expect(Math.abs(actual.x - expected.x), `${what} starts at ${actual.x}px, the text it lines up with at ${expected.x}px`).toBeLessThanOrEqual(1)
  if (size) expect(actual.size, `${what} is set at ${actual.size}, the text it lines up with at ${expected.size}`).toBe(expected.size)
}

test.describe('text stays in line when an edit opens', { tag: ['@flow'] }, () => {
  test('the new task row types its name and shows its date in line with the rows', async ({ page, request }, testInfo) => {
    test.skip(isPhone(testInfo), 'the inline Add task row is a desktop control')
    const title = await createTask(request, testInfo, 'align inline')
    await openView(page)
    const row = page.locator('[data-task-id]').filter({ has: page.getByRole('button', { name: `Rename ${title}`, exact: true }) })
    const name = await textStart(row.getByRole('button', { name: `Rename ${title}`, exact: true }))
    const due = await textStart(row.getByRole('button', { name: /^Change due date/ }))

    await page.getByRole('button', { name: 'Add task' }).first().click()
    const input = page.getByRole('textbox', { name: 'New task name' })
    await input.fill('Aligned')
    expectInLine(await textStart(input), name, 'the new task name')
    expectInLine(await textStart(page.getByRole('button', { name: 'Due date: Today' })), due, 'the new task date')
  })

  // The new task's date step on a desktop: the quick dates and Add time are buttons whose left
  // edges are on the heading's, so the column reads as one block under it.
  test('the new task date step lines its buttons up under its heading', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'the inline Add task row is a desktop control')
    await openView(page)
    await page.getByRole('button', { name: 'Add task' }).first().click()
    await page.getByRole('textbox', { name: 'New task name' }).fill('Aligned list')
    await page.getByRole('button', { name: /^Due date(: .+)?$/ }).click()
    const step = page.getByRole('dialog', { name: 'Due date for Aligned list' })
    const heading = await textStart(step.getByRole('heading', { name: 'When is it due?' }))
    // Tomorrow and No date are the second column, when the popover is wide enough for two.
    for (const name of ['Today', 'Next Monday', 'Add time']) {
      const box = await step.getByRole('button', { name, exact: true }).boundingBox()
      expect(Math.abs(Math.round(box.x) - heading.x), `${name} starts at the heading's left edge`).toBeLessThanOrEqual(1)
    }
  })

  test('renaming a task in place keeps its words where they were', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'align rename')
    await openView(page)
    const button = page.getByRole('button', { name: `Rename ${title}`, exact: true })
    const before = await textStart(button)
    await button.click()
    expectInLine(await textStart(page.getByRole('textbox', { name: 'Task name' })), before, 'the name being edited')
  })

  test('a new subtask is typed in line with the subtasks above it', async ({ page, request }, testInfo) => {
    const parent = await createTask(request, testInfo, 'align parent')
    const tasks = await (await request.get('/api/tasks', { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
    const parentId = (tasks.tasks || tasks).find((t) => t.title === parent).id
    const sub = await createTask(request, testInfo, 'align subtask', { parentId, dueAt: null })
    await openView(page)
    await openTask(page, parent)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    const subName = await textStart(panel.getByRole('button', { name: sub, exact: true }))
    await panel.getByRole('button', { name: 'Add subtask', exact: true }).last().click()
    expectInLine(await textStart(panel.getByRole('textbox', { name: 'Subtask name' })), subName, 'the new subtask name')
  })

  test('a new Board card is typed in line with the card titles in its lane', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'align card', { project: 'ui-test-project', section: 'Backlog', dueAt: null })
    await openView(page, 'board')
    const lane = page.getByRole('region', { name: 'Backlog', exact: true })
    const card = await textStart(lane.getByText(title, { exact: true }))
    await lane.getByRole('button', { name: 'Add task to Backlog' }).click()
    expectInLine(await textStart(lane.getByRole('textbox', { name: 'New task in Backlog' })), card, 'the new card name')
  })
})
