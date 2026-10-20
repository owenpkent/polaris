import { test, expect } from './fixtures.js'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { LONG_SUFFIX, UPDATE_INSTALLED, VIEWS, clippedContent, createTask, danglingLines, emptyRequest, failRequest, failureBanner, fakeUpdate, gotoView, holdRequest, longNames, openTask, openView, seedThread } from './support.js'

// Screenshots of every view and its main states, one file per view, state, width, and theme
// (`npm run shots`, scripts/shots.mjs). Runs in the shots-* projects of playwright.config.js
// against the same scratch server as the UI tests, so it needs no manual setup.
//
// Each shot is written to .shots/current and compared with .shots/baseline on this machine. A
// missing baseline is created (status "new"); a different one is reported as "changed" with the
// diff image in .shots/diff; nothing here ever fails a test. The baselines are local and
// ignored by git: fonts and anti-aliasing differ between machines. Shots that show an absolute
// date (an overdue task, the digest) would change from one day to the next, but e2e/fixtures.js
// freezes the browser clock at the seed moment, so they read the same on every run of a seed.

const ROOT = resolve('.shots')
const DIRS = {
  current: join(ROOT, 'current'),
  baseline: join(ROOT, 'baseline'),
  diff: join(ROOT, 'diff'),
  status: join(ROOT, 'status'),
}

// "shots-phone-dark" -> "phone-dark"
const variant = (testInfo) => testInfo.project.name.replace(/^shots-/, '')

// `mask` hides text that differs from run to run without being a layout change: a scratch folder
// name, a timestamp. Masked areas are drawn as solid boxes, so a mask covers the smallest element
// that holds the unstable text and never a whole card: whatever is under it can change unseen.
// Returns the shot's status.
async function shot(page, testInfo, view, state, mask = []) {
  const name = `${view}-${state}-${variant(testInfo)}`
  for (const dir of Object.values(DIRS)) mkdirSync(dir, { recursive: true })
  const current = join(DIRS.current, `${name}.png`)
  const buffer = await page.screenshot({ path: current, animations: 'disabled', caret: 'hide', mask })

  const baseline = join(DIRS.baseline, `${name}.png`)
  let status = 'same'
  if (!existsSync(baseline)) {
    copyFileSync(current, baseline)
    status = 'new'
  } else {
    try {
      // Playwright's own comparator: tolerant of anti-aliasing, and it writes the diff image.
      expect(buffer).toMatchSnapshot({ name: `${name}.png`, maxDiffPixelRatio: 0.0005 })
    } catch {
      status = 'changed'
      const diff = testInfo.outputPath(`${name}-diff.png`)
      if (existsSync(diff)) copyFileSync(diff, join(DIRS.diff, `${name}.png`))
    }
  }
  // What the shot cannot show in full (CONTRIBUTING.md, "Nothing is cut off"), listed by the run
  // beside the pixel changes. Measured after the screenshot, since the check scrolls controls.
  // The focus ring check is left to e2e/clipping.spec.js: it photographs every control.
  const clipped = [...(await clippedContent(page)), ...(await danglingLines(page))]
  writeFileSync(join(DIRS.status, `${name}.json`), JSON.stringify({ name, view, state, variant: variant(testInfo), status, clipped }))
  return status
}

// The digest names every task and goal by its id, and the seed makes those afresh for each run.
// Rather than masking the digest, which would hide its headings, text, and link colors from the
// comparison, the response is rewritten on its way to the page: each id becomes t_0000000001,
// t_0000000002, and so on in order of first appearance, with the same prefix and length as the
// real one. The digest then renders the same text every run and stays fully visible in the shot.
async function stabiliseDigestIds(page) {
  await page.route('**/api/digest', async (route) => {
    // Best effort, as in delayRequest: the shot may be taken and the test over before this lands.
    try {
      const response = await route.fetch()
      const body = await response.json()
      const seen = new Map()
      body.markdown = String(body.markdown ?? '').replace(/\b([a-z])_[0-9a-z]{10}\b/g, (id, prefix) => {
        if (!seen.has(id)) seen.set(id, `${prefix}_${String(seen.size + 1).padStart(10, '0')}`)
        return seen.get(id)
      })
      await route.fulfill({ response, json: body })
    } catch {
      // gone
    }
  })
}

// The digest's own markup: the block SafeMarkdown renders under the card, found from its heading.
const digestBody = (page) => page.getByRole('heading', { name: /^Command Center Digest/ }).locator('..')

// Removes every file of one shot, so a self-check leaves nothing in the gallery.
function forget(name) {
  for (const dir of Object.values(DIRS)) rmSync(join(dir, `${name}.${dir === DIRS.status ? 'json' : 'png'}`), { force: true })
}

const phone = (testInfo) => testInfo.project.name.includes('phone')

test.describe('shots', { tag: ['@visual'] }, () => {
  test('mytasks: list', async ({ page }, testInfo) => {
    await openView(page)
    await shot(page, testInfo, 'mytasks', 'list')
  })

  test('mytasks: panel', async ({ page }, testInfo) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    await shot(page, testInfo, 'mytasks', 'panel')
  })

  // The panel with an assignee set: the name in the Assignee box and its clear button. The demo
  // seed assigns this task, so nothing is created here that the later shots would then show.
  test('mytasks: panel assigned', async ({ page }, testInfo) => {
    await openView(page)
    await openTask(page, 'Draft ADR-003 hosting options')
    await expect(page.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Clear assignee' })).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'panel-assigned')
  })

  // The Subtasks section as Asana draws it: the done / total chip and + in its header, a done
  // subtask greyed, an open one, and the name box open under them. The task is made here.
  test('mytasks: panel subtasks', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'shot subtasks')
    await openView(page)
    await openTask(page, title)
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByRole('button', { name: 'Add subtask' }).first().click()
    const box = dialog.getByRole('textbox', { name: 'Subtask name' })
    for (const name of ['Book the venue', 'Send the invitations']) {
      await box.fill(name)
      await box.press('Enter')
      await expect(dialog.getByRole('checkbox', { name: `Complete ${name}` })).toBeVisible()
    }
    await dialog.getByRole('checkbox', { name: 'Complete Book the venue' }).click()
    await expect(dialog.getByText('1 / 2', { exact: true })).toBeVisible()
    // Ticking moved focus off the empty box, which closed it; the + opens it again.
    await dialog.getByRole('button', { name: 'Add subtask' }).first().click()
    await expect(box).toBeFocused()
    await shot(page, testInfo, 'mytasks', 'panel-subtasks')
  })

  // Scrolled to the end: the header row stays at the top with its line drawn under it.
  test('mytasks: panel scrolled', async ({ page }, testInfo) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(dialog.getByRole('button', { name: 'Mark complete' })).toBeInViewport()
    await shot(page, testInfo, 'mytasks', 'panel-scrolled')
  })

  // The panel's Thread section with a claim, an objection, and evidence posted against it, so the
  // type chips and the Objections only toggle are in the shot. The task is made here, due today.
  test('mytasks: panel thread', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'shot', [
      { type: 'claim', body: 'The cache key must include the query, or two searches share one answer.', confidence: 'medium' },
      { type: 'objection', body: 'A text search is typed a letter at a time. Keying every one fills the copy with noise.' },
      { type: 'evidence', body: 'api.js skips the cache when query.text is set, so the objection is already handled.' },
    ])
    await openView(page)
    await openTask(page, title)
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByRole('heading', { name: 'Thread' }).scrollIntoViewIfNeeded()
    await expect(dialog.getByRole('list', { name: 'Posts' })).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'panel-thread')
  })

  // The owner's judgement (stage 2): an accepted claim and a pinned summary, with the thread
  // settings row above the posts.
  test('mytasks: panel thread judged', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'judged', [
      { type: 'claim', body: 'The cache key must include the query, or two searches share one answer.', confidence: 'high' },
      { type: 'evidence', body: 'api.js skips the cache when query.text is set.' },
      { type: 'summary', body: 'Where we are: the query is part of the key, and text searches never hit the copy.' },
    ], { judge: { postIndex: 0, status: 'accepted' }, pin: 2 })
    await openView(page)
    await openTask(page, title)
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByRole('heading', { name: 'Thread' }).scrollIntoViewIfNeeded()
    await expect(dialog.getByRole('region', { name: 'Pinned state' })).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'panel-thread-judged')
  })

  // A closed thread that was forked: the Closed line, the way to its successor, and no form.
  test('mytasks: panel thread closed', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'closed', [
      { type: 'claim', body: 'The forced case blows up in finite time.' },
      { type: 'objection', body: 'Only with a smooth forcing term, which the unforced case has not got.' },
    ], { fork: 'The unforced case' })
    await openView(page)
    await openTask(page, title)
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByRole('heading', { name: 'Thread' }).scrollIntoViewIfNeeded()
    await expect(dialog.getByRole('button', { name: 'Open the successor thread' })).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'panel-thread-closed')
  })

  // The Threads page with one thread to look at, made here so the four figures are real.
  test('threads: page', async ({ page, request }, testInfo) => {
    await seedThread(request, testInfo, 'page', [
      { type: 'claim', body: 'A claim.' },
      { type: 'objection', body: 'An objection nobody has answered.' },
      { type: 'result', body: 'A result.' },
    ], { judge: { postIndex: 2, status: 'accepted' } })
    await openView(page, 'threads')
    await expect(page.getByRole('article').first()).toBeVisible()
    await shot(page, testInfo, 'threads', 'page')
  })

  // The checklist edit form on the seeded checklist, with its item rows, and the Start form.
  // Neither is saved: a start would add tasks that other shots in this worker would show.
  test('checklists: edit', async ({ page }, testInfo) => {
    await openView(page, 'checklists')
    await page.getByRole('button', { name: 'Edit Packing: weekend trip', exact: true }).click()
    await expect(page.getByRole('form', { name: 'Edit Packing: weekend trip' }).getByRole('textbox', { name: 'Item 5' })).toBeVisible()
    await shot(page, testInfo, 'checklists', 'edit')
  })

  test('checklists: start', async ({ page }, testInfo) => {
    await openView(page, 'checklists')
    await page.getByRole('button', { name: 'Start Packing: weekend trip', exact: true }).click()
    const form = page.getByRole('form', { name: 'Start Packing: weekend trip' })
    await expect(form.getByRole('option', { name: 'UI Test Project' })).toBeAttached()
    await shot(page, testInfo, 'checklists', 'start')
  })

  test('mytasks: new', async ({ page }, testInfo) => {
    await openView(page)
    if (phone(testInfo)) {
      await page.getByRole('button', { name: 'New task' }).click()
      const sheet = page.getByRole('dialog', { name: 'New task' })
      await sheet.getByRole('textbox', { name: 'New task name' }).fill('Book the van service')
      await sheet.getByRole('button', { name: 'Tomorrow', exact: true }).click()
    } else {
      await page.getByRole('button', { name: 'Add task' }).first().click()
      await page.getByRole('textbox', { name: 'New task name' }).fill('Book the van service')
    }
    await shot(page, testInfo, 'mytasks', 'new')
  })

  // The sheet opened by a share (shareIntake.js): title and notes prefilled from the shared text,
  // and the link line under them. Opens at both widths, since a share always opens the sheet.
  test('mytasks: new from share', async ({ page }, testInfo) => {
    await openView(page, 'mytasks', 'share-text=Book%20the%20van%20service%20https%3A%2F%2Fexample.com%2Fgarage%2Fbook')
    const sheet = page.getByRole('dialog', { name: 'New task' })
    await expect(sheet.getByRole('textbox', { name: 'New task name' })).toHaveValue('Book the van service')
    await expect(sheet.getByText('Link: example.com/garage/book')).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'new-from-share')
  })

  // "When is it due?" after a new task's title: the desktop row's popover, the phone sheet's step.
  test('mytasks: new due step', async ({ page }, testInfo) => {
    await openView(page)
    if (phone(testInfo)) {
      await page.getByRole('button', { name: 'New task' }).click()
      const sheet = page.getByRole('dialog', { name: 'New task' })
      await sheet.getByRole('textbox', { name: 'New task name' }).fill('Book the van service')
      await sheet.getByRole('textbox', { name: 'New task name' }).press('Enter')
      await expect(sheet.getByRole('heading', { name: 'When is it due?' })).toBeVisible()
    } else {
      await page.getByRole('button', { name: 'Add task' }).first().click()
      await page.getByRole('textbox', { name: 'New task name' }).fill('Book the van service')
      await page.getByRole('textbox', { name: 'New task name' }).press('Enter')
      await expect(page.getByRole('heading', { name: 'When is it due?' })).toBeVisible()
    }
    await shot(page, testInfo, 'mytasks', 'new-due-step')
  })

  // The custom repeat builder on a weekly rule, with its next dates.
  test('task: custom repeat', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'custom repeat', { recurrence: 'FREQ=WEEKLY;BYDAY=MO,TH' })
    await openView(page)
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel.getByRole('button', { name: 'Skip this one' })).toBeVisible()
    await panel.getByRole('button', { name: /^Repeat, / }).click()
    await page.getByRole('menuitemradio', { name: 'Custom' }).click()
    const builder = page.getByRole('group', { name: 'Custom repeat' })
    await expect(builder.getByRole('status')).toHaveText(/^Next: /)
    await shot(page, testInfo, 'task', 'custom-repeat')
  })

  // The Repeat menu's quick picks, worded from a Wednesday, October 13 due date. The task is due a
  // year out, in the Later group that starts collapsed, so the list shots that follow never show it.
  test('task: repeat menu', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'repeat menu', { dueAt: '2027-10-13' })
    await openView(page)
    await page.getByRole('button', { name: 'Expand Later' }).click()
    await openTask(page, title)
    await page.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Repeat, never' }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Monthly on the second Wednesday' })).toBeVisible()
    await shot(page, testInfo, 'task', 'repeat-menu')
  })

  // The custom builder counting from the finish, with an end date: the day choices give way to a
  // note, and Ends shows its date box. Due a year out, like the menu's task above.
  test('task: custom repeat from the finish', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'repeat from finish', { dueAt: '2027-10-13', recurrence: 'FREQ=DAILY;INTERVAL=3;UNTIL=20271231;X-FROM=COMPLETION' })
    await openView(page)
    await page.getByRole('button', { name: 'Expand Later' }).click()
    await openTask(page, title)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await panel.getByRole('button', { name: /^Repeat, / }).click()
    await page.getByRole('menuitemradio', { name: 'Custom' }).click()
    const builder = page.getByRole('group', { name: 'Custom repeat' })
    await expect(builder.getByRole('radio', { name: 'The day I finish it' })).toBeChecked()
    await expect(builder.getByRole('status')).toHaveText(/^If each is finished on its due date, next: /)
    await builder.getByRole('group', { name: 'Ends' }).scrollIntoViewIfNeeded()
    await shot(page, testInfo, 'task', 'custom-repeat-finish')
  })

  test('mytasks: due menu', async ({ page }, testInfo) => {
    await openView(page)
    await page.getByRole('button', { name: 'Change due date for Reply to accessibility audit feedback' }).click()
    await expect(page.getByRole('dialog', { name: 'Due date for Reply to accessibility audit feedback' }).getByRole('grid')).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'due-menu')
  })

  // The due date menu on a task with a time, from the panel's Due date field (near the top, so
  // the whole menu has room under it): the time box filled and Remove time.
  test('mytasks: due menu with a time', async ({ page }, testInfo) => {
    await openView(page)
    await openTask(page, 'Draft ADR-003 hosting options')
    await page.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: /^Due date, / }).click()
    const menu = page.getByRole('dialog', { name: 'Due date', exact: true })
    await expect(menu.getByRole('button', { name: 'Remove time' })).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'due-menu-time')
  })

  // The due date picker on a weekly repeat, from the panel's Due date field: Repeats under the
  // month with the weekday buttons, and the next dates tinted. Due a year out, in the Later group
  // that starts collapsed, so the list shots that follow never show it.
  test('mytasks: due menu with a repeat', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'due menu repeat', { dueAt: '2027-10-14', recurrence: 'FREQ=WEEKLY;BYDAY=MO,TH' })
    await openView(page)
    await page.getByRole('button', { name: 'Expand Later' }).click()
    await openTask(page, title)
    await page.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: /^Due date, / }).click()
    const menu = page.getByRole('dialog', { name: 'Due date', exact: true })
    await expect(menu.getByRole('button', { name: 'Monday, October 18, 2027, repeats', exact: true })).toBeVisible()
    // On a phone the picker scrolls; the weekday buttons are what this state is for.
    await menu.getByRole('button', { name: 'Thursday', exact: true }).scrollIntoViewIfNeeded()
    await shot(page, testInfo, 'mytasks', 'due-menu-repeat')
  })

  // "When is it due?" with Add time opened under the month.
  test('mytasks: new due step with a time', async ({ page }, testInfo) => {
    await openView(page)
    let scope = page
    if (phone(testInfo)) {
      await page.getByRole('button', { name: 'New task' }).click()
      scope = page.getByRole('dialog', { name: 'New task' })
    } else {
      await page.getByRole('button', { name: 'Add task' }).first().click()
    }
    await scope.getByRole('textbox', { name: 'New task name' }).fill('Book the van service')
    await scope.getByRole('textbox', { name: 'New task name' }).press('Enter')
    await page.getByRole('button', { name: 'Add time' }).click()
    await page.getByLabel('Time', { exact: true }).fill('09:30')
    await shot(page, testInfo, 'mytasks', 'new-due-step-time')
  })

  // "When is it due?" with Weekly chosen under the month: the weekdays, and the next dates tinted.
  test('mytasks: new due step with a repeat', async ({ page }, testInfo) => {
    await openView(page)
    let scope = page
    if (phone(testInfo)) {
      await page.getByRole('button', { name: 'New task' }).click()
      scope = page.getByRole('dialog', { name: 'New task' })
    } else {
      await page.getByRole('button', { name: 'Add task' }).first().click()
    }
    await scope.getByRole('textbox', { name: 'New task name' }).fill('Book the van service')
    await scope.getByRole('textbox', { name: 'New task name' }).press('Enter')
    const due = phone(testInfo) ? scope : page.getByRole('dialog', { name: 'Due date for Book the van service' })
    await due.getByRole('combobox', { name: 'Repeats' }).selectOption('weekly')
    await expect(due.getByRole('grid').getByRole('button', { name: /, repeats$/ }).first()).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'new-due-step-repeat')
  })

  test('mytasks: sort menu', async ({ page }, testInfo) => {
    await openView(page)
    await page.getByRole('button', { name: 'Sort' }).click()
    await expect(page.getByRole('menu', { name: 'Sort tasks' })).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'sort-menu')
  })

  test('mytasks: filter menu', async ({ page }, testInfo) => {
    await openView(page)
    await page.getByRole('button', { name: 'Filter' }).click()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Urgent' })).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'filter-menu')
  })

  // The list with the Blocked filter on: only the seeded task that another task holds.
  test('mytasks: blocked filter', async ({ page }, testInfo) => {
    await openView(page)
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Blocked' }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Open Assemble the standing desk' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Choose a standing desk' })).toHaveCount(0)
    await shot(page, testInfo, 'mytasks', 'blocked-filter')
  })

  test('mytasks: goal menu', async ({ page }, testInfo) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    await page.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Add to goal' }).click()
    await expect(page.getByRole('menu', { name: 'Add to goal' }).getByRole('menuitem').first()).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'goal-menu')
  })

  // The drawer is the phone's navigation; on desktop the sidebar is in every shot already.
  test('mytasks: drawer', async ({ page }, testInfo) => {
    test.skip(!phone(testInfo), 'phone layout only')
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await drawer.getByRole('button', { name: 'More' }).click()
    await shot(page, testInfo, 'mytasks', 'drawer')
  })

  // Every name lengthened on its way to the page (longNames in e2e/support.js), so a layout that
  // only holds for short names shows up here as well as in e2e/clipping.spec.js.
  test('longnames: mytasks', async ({ page }, testInfo) => {
    await longNames(page)
    await openView(page)
    await shot(page, testInfo, 'longnames', 'mytasks')
  })

  test('longnames: board', async ({ page }, testInfo) => {
    await longNames(page)
    await openView(page, 'board')
    await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: `UI Test Text${LONG_SUFFIX}` })
    await shot(page, testInfo, 'longnames', 'board')
  })

  test('longnames: projects', async ({ page }, testInfo) => {
    await longNames(page)
    await openView(page, 'projects')
    await shot(page, testInfo, 'longnames', 'projects')
  })

  test('longnames: panel', async ({ page }, testInfo) => {
    await longNames(page)
    await openView(page)
    await page.getByRole('button', { name: /^Open Draft ADR-003 hosting options/ }).getByText(/^Draft ADR-003/).click()
    await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible()
    await shot(page, testInfo, 'longnames', 'panel')
  })

  test('inbox: list', async ({ page }, testInfo) => {
    await openView(page, 'inbox')
    await shot(page, testInfo, 'inbox', 'list')
  })

  test('inbox: accept', async ({ page }, testInfo) => {
    await openView(page, 'inbox')
    await page.getByRole('button', { name: 'Accept' }).first().click()
    await expect(page.getByRole('button', { name: 'Accept as task' })).toBeVisible()
    await shot(page, testInfo, 'inbox', 'accept')
  })

  for (const view of ['board', 'goals', 'projects', 'checklists', 'rules', 'github']) {
    // threads: page is below, since it needs a thread to show.
    test(`${view}: page`, async ({ page }, testInfo) => {
      await openView(page, view)
      await shot(page, testInfo, view, 'page')
    })
  }

  // The states between success and failure (initiatives/ui-ux-testing.md, phase 5), already
  // proven by e2e/states.spec.js: every view slow, failed, and empty. VIEWS and the route helpers
  // are shared with that spec (e2e/support.js). The loading shot uses holdRequest, not
  // delayRequest: a route that never answers, so the screenshot is never a race against the real
  // answer landing first, only against the loading text appearing, which the assertion waits for.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  for (const view of VIEWS) {
    test(`${view.id}: loading`, async ({ page }, testInfo) => {
      await holdRequest(page, view.request)
      await gotoView(page, view.id)
      await expect(page.getByRole('main').getByText(view.loading, { exact: true })).toBeVisible()
      await shot(page, testInfo, view.id, 'loading')
    })

    test(`${view.id}: failed`, async ({ page }, testInfo) => {
      await failRequest(page, view.request)
      await openView(page, view.id)
      const banner = failureBanner(page)
      await expect(banner).toBeVisible()
      await expect(banner.getByRole('button', { name: 'Retry' })).toBeVisible()
      await shot(page, testInfo, view.id, 'failed')
    })

    test(`${view.id}: empty`, async ({ page }, testInfo) => {
      await emptyRequest(page, view.emptyRequest || view.request, view.emptyBody)
      await openView(page, view.id)
      const main = page.getByRole('main')
      await expect(main.getByText(view.loading, { exact: true })).toHaveCount(0)
      for (const text of view.emptyText) await expect(main.getByText(text)).toBeVisible()
      for (const name of view.emptyControls) await expect(main.getByRole('button', { name, exact: true }).first()).toBeVisible()
      await expect(failureBanner(page)).toHaveCount(0)
      await shot(page, testInfo, view.id, 'empty')
    })
  }

  test('digest: page', async ({ page }, testInfo) => {
    await stabiliseDigestIds(page)
    await openView(page, 'digest')
    await expect(digestBody(page)).toBeVisible()
    await shot(page, testInfo, 'digest', 'page')
  })

  // A guard for the digest shot itself: a visible change inside the digest that moves nothing
  // (red text on a yellow background) must come back as "changed" with a diff, which a mask over
  // the whole card would have hidden. Its files are removed again, so it never reaches the gallery.
  test('digest: style change is reported', async ({ page }, testInfo) => {
    await stabiliseDigestIds(page)
    await openView(page, 'digest')
    await expect(digestBody(page)).toBeVisible()
    const name = `selfcheck-digest-${variant(testInfo)}`
    forget(name)
    try {
      expect(await shot(page, testInfo, 'selfcheck', 'digest')).toBe('new')
      await digestBody(page).evaluate((root) => {
        for (const el of [root, ...root.querySelectorAll('*')]) {
          el.style.setProperty('color', 'red', 'important')
          el.style.setProperty('background-color', 'yellow', 'important')
        }
      })
      expect(await shot(page, testInfo, 'selfcheck', 'digest')).toBe('changed')
      expect(existsSync(join(DIRS.diff, `${name}.png`))).toBe(true)
    } finally {
      forget(name)
    }
  })

  // The update icon shows only while the server names a newer signed release, which the test
  // server never does, so GET /api/update is routed to the fixture (docs/update-proposal.md, 4B).
  test('update: icon', async ({ page }, testInfo) => {
    await fakeUpdate(page)
    await openView(page)
    await expect(page.getByRole('button', { name: 'Update available' })).toBeVisible()
    await shot(page, testInfo, 'update', 'icon')
  })

  test('update: panel', async ({ page }, testInfo) => {
    await fakeUpdate(page)
    await openView(page)
    await page.getByRole('button', { name: 'Update available' }).click()
    await expect(page.getByRole('dialog', { name: 'Update available' })).toBeVisible()
    await shot(page, testInfo, 'update', 'panel')
  })

  test('update: updated', async ({ page }, testInfo) => {
    await fakeUpdate(page, UPDATE_INSTALLED)
    await openView(page)
    await page.getByRole('button', { name: 'Update installed' }).click()
    await expect(page.getByRole('dialog', { name: 'Update installed' })).toBeVisible()
    await shot(page, testInfo, 'update', 'updated')
  })

  test('settings: page', async ({ page }, testInfo) => {
    await openView(page, 'settings')
    // The backup folder is a scratch directory with a random name, and the newest copy carries
    // the time the test server started, and the dashboard build carries its commit and build time.
    const values = page.getByText(/^(Folder|Newest copy|Dashboard)$/).locator('xpath=following-sibling::span')
    await shot(page, testInfo, 'settings', 'page', [values])
  })

  // The Reminders card only exists inside the Android app, so a stand-in for its bridge is
  // installed before the page loads.
  test('settings: reminders', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      window.Capacitor = {
        isNativePlatform: () => true,
        nativePromise: async () => ({ display: 'granted', notifications: [] }),
        addListener: () => ({ remove() {} }),
      }
    })
    await openView(page, 'settings')
    const card = page.getByRole('region', { name: 'Reminders' })
    await expect(card).toBeVisible()
    // Turned on, so the time field is live too; the stand-in grants the permission at once.
    await card.getByRole('checkbox', { name: 'Remind me on the day a task is due' }).check()
    await expect(card.getByLabel('Time')).toBeEnabled()
    // The card sits below the connection and agent cards, under the fold at both widths. The
    // page's scroll-padding-top (src/index.css) keeps it clear of the sticky top bar.
    await card.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    const values = page.getByText(/^(Folder|Newest copy|Dashboard)$/).locator('xpath=following-sibling::span')
    await shot(page, testInfo, 'settings', 'reminders', [values])
  })

  // A preview with one problem, so both the task list and the problem list are in the shot.
  test('settings: import preview', async ({ page }, testInfo) => {
    await openView(page, 'settings')
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Import tasks' }).click()
    const card = page.getByRole('region', { name: 'Import tasks' })
    await card.getByLabel('Tasks to import').fill('title,priority,due,notes\nWater the beds,high,2026-11-01,\nOrder seed catalogue,low,,Spring list\nFix the gate,soonish,,')
    await card.getByRole('button', { name: 'Preview' }).click()
    await expect(card.getByRole('list', { name: 'Problems' })).toBeVisible()
    // Scrolled to the buttons, so the preview under them is in the shot.
    await card.getByRole('button', { name: 'Preview' }).evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await shot(page, testInfo, 'settings', 'import-preview')
  })

  // The About card is the last on the page, so the jump button brings it into the shot. The
  // dashboard build carries the commit and the build time, which change with every build.
  test('settings: about', async ({ page }, testInfo) => {
    await openView(page, 'settings')
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'About' }).click()
    const card = page.getByRole('region', { name: 'About' })
    await expect(card.getByText(/^v\d/).last()).toBeVisible()
    await shot(page, testInfo, 'settings', 'about', [card.getByText('Dashboard', { exact: true }).locator('xpath=following-sibling::span')])
  })
})
