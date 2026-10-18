import { test, expect } from './fixtures.js'
import { TOKEN } from './server.js'
import { VIEWS, clippedContent, createTask, danglingLines, hiddenFocusRings, fakeUpdate, isPhone, LONG_SUFFIX, longNames, openTask, openView, seedThread, smallTargets } from './support.js'

// Nothing is cut off (CONTRIBUTING.md, "Nothing is cut off"): every view, panel, sheet, and menu
// is checked with clippedContent (e2e/support.js), which fails on text a box hides, content off
// the side of the screen or out of a scroll box's reach, and a control that cannot be scrolled
// into full view or has something drawn over it. @all-widths runs a group in every viewport
// project: desktop and phone, which take any test not tagged for an extra project, plus 320px and
// a phone turned sideways, whose projects select it by that tag (playwright.config.js). The
// widths between the breakpoint and the desktop viewport, where a sidebar and a full toolbar
// share the least room, are covered by the last group. e2e/conventions.test.js lists the suite
// per project and fails if these groups stop running at any of the four sizes.

// The long and awkward titles of the "UI Test Text" project (command-center/src/dev/seed-ui-test.ts).
const URL_TITLE =
  'https://example.com/' +
  'a/very/long/path/that/keeps/going/to/check/how/the/dashboard/handles/an/unbroken/url/' +
  'as/a/task/title/without/wrapping/or/causing/horizontal/scroll/on/a/narrow/phone/screen'

// A long title made of ordinary words, the kind that is really typed.
const WORDY = 'Call the insurance company about the wheelchair van lift repair claim and ask whether the second quote counts'

// Content, focus rings, and the lines between rows, in one list so a failure shows them all.
async function expectNothingCutOff(page) {
  expect([...(await clippedContent(page)), ...(await danglingLines(page)), ...(await hiddenFocusRings(page))]).toEqual([])
}

// A text box that grows with its text (useFitToText.js) refits in a ResizeObserver callback, a
// frame or so after its width or its text changes. Wait until it holds its whole text before the
// one-shot cut-off sweep, so the sweep measures the settled box; a box that never fits still
// fails here, after the wait.
async function expectFitsItsText(box) {
  await expect.poll(() => box.evaluate((el) => el.scrollHeight - el.clientHeight), { message: 'the box never grew to hold its text' }).toBeLessThanOrEqual(1)
}

test.describe('nothing is cut off', { tag: ['@a11y', '@all-widths'] }, () => {
  for (const view of VIEWS) {
    test(`${view.label}`, async ({ page }) => {
      await openView(page, view.id)
      await expect(page.getByRole('main').getByText(view.loading, { exact: true })).toHaveCount(0)
      await expectNothingCutOff(page)
    })
  }

  test('Settings', async ({ page }) => {
    await openView(page, 'settings')
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
    await expectNothingCutOff(page)
  })

  test('My tasks with the long titles shown', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Expand No due date' }).click()
    await expect(page.getByRole('button', { name: `Open ${URL_TITLE}`, exact: true })).toBeVisible()
    await expectNothingCutOff(page)
  })

  test('the task panel', async ({ page }) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    await expectNothingCutOff(page)
  })

  test('the task panel for a long URL title', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Expand No due date' }).click()
    await openTask(page, URL_TITLE)
    await expectNothingCutOff(page)
  })

  // Switching task reloads the panel, which unmounts the title and assignee boxes and mounts new
  // ones. A new box with the same text as the last must still be fitted to it (useFitToText.js
  // follows the box, not a ref): a subtask with its parent's assignee is the everyday case. The
  // fit must then hold through a change of width.
  test('the task panel after opening a subtask with the same long assignee', async ({ page, request }, testInfo) => {
    const headers = { Authorization: `Bearer ${TOKEN}` }
    const assignee = 'Someone whose name is long enough to wrap onto several lines of the assignee box'
    const parentTitle = await createTask(request, testInfo, 'shared assignee parent', { assignee })
    const listed = await request.get('/api/tasks', { headers })
    expect(listed.ok()).toBeTruthy()
    const parent = (await listed.json()).tasks.find((t) => t.title === parentTitle)
    const subtaskTitle = `${parentTitle} subtask`
    const created = await request.post('/api/tasks', { headers, data: { title: subtaskTitle, assignee, parentId: parent.id } })
    expect(created.ok(), `create subtask failed: ${created.status()}`).toBeTruthy()

    await openView(page)
    await openTask(page, parentTitle)
    const panel = page.getByRole('dialog', { name: 'Task details' })
    await expect(panel.getByRole('textbox', { name: 'Assignee' })).toHaveValue(assignee)
    await expectNothingCutOff(page)

    await panel.getByRole('button', { name: subtaskTitle, exact: true }).click()
    await expect(panel.getByRole('textbox', { name: 'Task title' })).toHaveValue(subtaskTitle)
    await expect(panel.getByRole('textbox', { name: 'Assignee' })).toHaveValue(assignee)
    await expectFitsItsText(panel.getByRole('textbox', { name: 'Assignee' }))
    await expectNothingCutOff(page)

    // Narrower, the box refits a frame after the resize (CI caught it at 101px holding 244px).
    const { width, height } = testInfo.project.use.viewport
    await page.setViewportSize({ width: Math.max(320, width - 70), height })
    await expect(panel.getByRole('textbox', { name: 'Assignee' })).toHaveValue(assignee)
    await expectFitsItsText(panel.getByRole('textbox', { name: 'Assignee' }))
    await expectNothingCutOff(page)
  })

  test('a long title of ordinary words, in the list and the panel', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, WORDY)
    await openView(page)
    await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible()
    await expectNothingCutOff(page)
    await openTask(page, title)
    await expectNothingCutOff(page)
  })

  test('the sort, filter, and group menus', async ({ page }) => {
    await openView(page)
    for (const name of ['Sort', 'Filter', 'Group']) {
      await page.getByRole('button', { name, exact: true }).click()
      await expectNothingCutOff(page)
      await page.keyboard.press('Escape')
    }
  })

  test('the due date menu', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Change due date for Reply to accessibility audit feedback' }).click()
    await expect(page.getByRole('menu', { name: 'Due date for Reply to accessibility audit feedback' })).toBeVisible()
    await expectNothingCutOff(page)
  })

  test('the goal menu in the task panel', async ({ page }) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    await page.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Add to goal' }).click()
    await expect(page.getByRole('menu', { name: 'Add to goal' }).getByRole('menuitem').first()).toBeVisible()
    await expectNothingCutOff(page)
  })

  test('adding a task', async ({ page }, testInfo) => {
    await openView(page)
    if (isPhone(testInfo)) {
      await page.getByRole('button', { name: 'New task' }).click()
      await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible()
    } else {
      await page.getByRole('button', { name: 'Add task' }).first().click()
    }
    await page.getByRole('textbox', { name: 'New task name' }).fill(WORDY)
    await expectNothingCutOff(page)
  })

  // "When is it due?" after a title (AddDuePanel.jsx): the desktop row's popover, which spans a
  // 320px window, and the phone sheet's date step, with the custom repeat builder open in both.
  test('the due date step of a new task', async ({ page }, testInfo) => {
    await openView(page)
    let scope
    if (isPhone(testInfo)) {
      await page.getByRole('button', { name: 'New task' }).click()
      scope = page.getByRole('dialog', { name: 'New task' })
      await scope.getByRole('textbox', { name: 'New task name' }).fill(WORDY)
      await scope.getByRole('textbox', { name: 'New task name' }).press('Enter')
    } else {
      await page.getByRole('button', { name: 'Add task' }).first().click()
      await page.getByRole('textbox', { name: 'New task name' }).fill(WORDY)
      await page.getByRole('textbox', { name: 'New task name' }).press('Enter')
      scope = page.getByRole('dialog', { name: `Due date for ${WORDY}` })
    }
    await expect(scope.getByRole('heading', { name: 'When is it due?' })).toBeVisible()
    await expectNothingCutOff(page)
    await scope.getByRole('combobox', { name: 'Repeat' }).selectOption('custom')
    await scope.getByRole('combobox', { name: 'Repeat unit' }).selectOption('month')
    await expect(scope.getByRole('combobox', { name: 'Day of the month' })).toBeVisible()
    await expectNothingCutOff(page)
  })

  // A group's Add task row is there on a phone too, and its date step is a popover that has to
  // fit seven 44px days at 320px (the Popover's gutter of 0 in InlineTaskInput.jsx).
  test('the due date step from an Add task row', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Add task' }).first().click()
    await page.getByRole('textbox', { name: 'New task name' }).fill(WORDY)
    await page.getByRole('textbox', { name: 'New task name' }).press('Enter')
    const due = page.getByRole('dialog', { name: `Due date for ${WORDY}` })
    await expect(due.getByRole('heading', { name: 'When is it due?' })).toBeVisible()
    // Seen as it opens, before the cut-off check scrolls any control into view: the popover is not
    // scrolled sideways, and the heading and Today sit inside it (review on #67, where a 400px cap
    // left the date step scrolled 142px with its left side out of sight).
    expect(await due.evaluate((el) => {
      const pop = el.closest('[data-popover]')
      const box = pop.getBoundingClientRect()
      const inside = (node) => { const r = node.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 }
      const today = [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Today')
      return { scrollLeft: pop.scrollLeft, heading: inside(el.querySelector('h3')), today: inside(today) }
    })).toEqual({ scrollLeft: 0, heading: true, today: true })
    expect(await smallTargets(due, 'button, select')).toEqual([])
    await expectNothingCutOff(page)
  })

  // The custom repeat builder grows while it is open (day to week adds the weekday buttons). As a
  // popover it widened in place and put Save 53px off a 390px screen (review on #66); in the
  // panel's column it has to stay inside the screen's width, with Save whole, before anything
  // scrolls.
  test('the custom repeat builder after its unit changes', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'repeat resize', { recurrence: 'daily' })
    await openView(page)
    await openTask(page, title)
    await page.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: /^Repeat, / }).click()
    await page.getByRole('menuitemradio', { name: 'Custom' }).click()
    const builder = page.getByRole('group', { name: 'Custom repeat' })
    await builder.getByRole('combobox', { name: 'Repeat unit' }).selectOption('week')
    await expect(builder.getByRole('button', { name: 'Sunday' })).toBeVisible()
    await expect.poll(() => builder.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const save = [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').getBoundingClientRect()
      return box.left >= 0 && box.right <= window.innerWidth && save.left >= 0 && save.right <= window.innerWidth
    })).toBe(true)
    await expectNothingCutOff(page)
  })

  test('the navigation drawer', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'the drawer is the phone navigation')
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible()
    await expectNothingCutOff(page)
  })

  test('the inbox accept form', async ({ page }) => {
    await openView(page, 'inbox')
    await page.getByRole('button', { name: 'Accept' }).first().click()
    await expect(page.getByRole('button', { name: 'Accept as task' })).toBeVisible()
    await expectNothingCutOff(page)
  })

  test('the Board on the long titles', async ({ page }) => {
    await openView(page, 'board')
    await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'UI Test Text' })
    await expect(page.getByRole('region', { name: 'No section', exact: true })).toBeVisible()
    await expectNothingCutOff(page)
  })

  test('the update panel', async ({ page }) => {
    await fakeUpdate(page)
    await openView(page)
    await page.getByRole('button', { name: 'Update available' }).click()
    await expect(page.getByRole('dialog', { name: 'Update available' })).toBeVisible()
    await expectNothingCutOff(page)
  })
})

// The task panel opens from four views; each is checked with it open. Names are matched by their
// start, so the same steps work with longNames on.
const startsWith = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
let made = 0
const PANELS = [
  {
    name: 'from My tasks',
    open: async (page) => {
      await openView(page)
      await page.getByRole('button', { name: startsWith('Open Reply to accessibility audit feedback') }).getByText(startsWith('Reply to accessibility')).click()
    },
  },
  {
    // The seed assigns this one, so the Assignee field and the Assigned to label hold a name.
    name: 'for an assigned task',
    open: async (page) => {
      await openView(page)
      await page.getByRole('button', { name: startsWith('Open Draft ADR-003 hosting options') }).getByText(startsWith('Draft ADR-003')).click()
    },
  },
  {
    name: 'from the Board',
    open: async (page) => {
      await openView(page, 'board')
      await page.getByRole('button', { name: startsWith('Board card gamma') }).click()
    },
  },
  {
    name: 'from Threads',
    open: async (page, request, testInfo) => {
      const { title } = await seedThread(request, testInfo, 'clip', [{ type: 'claim', body: 'A claim long enough to wrap onto a second line in the panel at every width.', confidence: 'medium' }])
      await openView(page, 'threads')
      await page.getByRole('button', { name: startsWith(`Open ${title}`) }).click()
    },
  },
  {
    name: 'from Checklists',
    open: async (page, request, testInfo) => {
      const name = `UI test checklist clip ${testInfo.project.name} ${++made}`
      const res = await request.post('/api/checklists', { headers: { Authorization: `Bearer ${TOKEN}` }, data: { name, items: ['Passport', 'Phone charger'] } })
      expect(res.ok(), `create checklist failed: ${res.status()}`).toBeTruthy()
      await openView(page, 'checklists')
      await page.getByRole('button', { name: startsWith(`Start ${name}`) }).click()
      await page.getByRole('form', { name: startsWith(`Start ${name}`) }).getByRole('button', { name: 'Start', exact: true }).click()
    },
  },
]

for (const long of [false, true]) {
  test.describe(long ? 'nothing is cut off with long names' : 'nothing is cut off with the task panel open', { tag: ['@a11y', '@all-widths'] }, () => {
    for (const panel of PANELS) {
      test(`the task panel ${panel.name}`, async ({ page, request }, testInfo) => {
        if (long) await longNames(page)
        await panel.open(page, request, testInfo)
        await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible()
        await expectNothingCutOff(page)
      })
    }
    if (!long) return
    for (const view of [...VIEWS.map((v) => v.id), 'settings']) {
      test(`${view}`, async ({ page }) => {
        await longNames(page)
        await openView(page, view)
        await expectNothingCutOff(page)
      })
    }
    test('My tasks with every group open', async ({ page }) => {
      // Every row of every group, each name made long, checked one element at a time: on CI's
      // Windows runner it took about 21s of the 30s limit on main, and the rows other tests in the
      // same worker add push it over. The check is the point, so it gets the time, not a cut.
      test.slow()
      await longNames(page)
      await openView(page)
      for (const name of ['Expand Later', 'Expand No due date']) await page.getByRole('button', { name, exact: true }).click()
      await expectNothingCutOff(page)
    })
    test('the Board on the long titles', async ({ page }) => {
      await longNames(page)
      await openView(page, 'board')
      await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: `UI Test Text${LONG_SUFFIX}` })
      await expectNothingCutOff(page)
    })
  })
}

// Just over the breakpoint the sidebar is in and the content column is at its narrowest; a
// toolbar or a table that fits at 1280 runs out of room here first. Desktop project only.
test.describe('nothing is cut off between the breakpoint and the desktop width', { tag: ['@a11y'] }, () => {
  for (const width of [641, 800, 1024]) {
    for (const view of ['mytasks', 'inbox', 'board', 'goals', 'projects', 'checklists', 'threads', 'rules', 'digest', 'github', 'settings']) {
      test(`${view} at ${width}px`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.use.viewport.width !== 1280, 'desktop project only')
        await page.setViewportSize({ width, height: 800 })
        await openView(page, view)
        await expectNothingCutOff(page)
      })
    }
    test(`the task panel at ${width}px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.use.viewport.width !== 1280, 'desktop project only')
      await page.setViewportSize({ width, height: 800 })
      await openView(page)
      await openTask(page, 'Reply to accessibility audit feedback')
      await expectNothingCutOff(page)
    })
  }
})

// The check itself, on a page made of known cut-offs: each kind must be reported, and each thing
// that only looks like one must not. Without this, a check that quietly stopped seeing anything
// would pass every test above.
test.describe('the cut-off check', { tag: ['@a11y'] }, () => {
  test('reports each kind of cut-off and nothing else', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 300 })
    await page.setContent(`
      <style>
        body { margin: 0; overflow-x: hidden; font: 16px sans-serif; }
        .box { width: 80px; overflow: hidden; white-space: nowrap; }
        .ellipsis { width: 80px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .bar { position: fixed; left: 0; right: 0; bottom: 0; height: 60px; background: #333; }
        .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
        :focus-visible { outline: 2px solid #4a8cff; outline-offset: 2px; }
        .cols { display: flex; height: 40px; }
        .cols > span { width: 90px; }
        .cols > span + span { border-left: 1px solid #888; }
      </style>
      <button style="margin: 8px">Ring in the clear</button>
      <div><button style="display: block; width: 160px; height: 44px">Ring under the next row</button><div style="position: relative; height: 44px; width: 200px; background: #555"></div></div>
      <div class="cols"><span>a</span><span>Row left open</span></div>
      <div style="height: 8px"></div>
      <div class="cols" style="border-bottom: 1px solid #888"><span>b</span><span>Row closed by a line</span></div>
      <div class="box">Clipped without an ellipsis</div>
      <div class="ellipsis">Shortened with no way to read it</div>
      <div class="ellipsis" title="Shortened with the whole text in a title">Shortened with the whole text in a title</div>
      <div style="width: 60px; height: 30px; overflow: hidden"><button style="width: 120px">Half hidden button</button></div>
      <div style="margin-left: 360px; white-space: nowrap">Off the right edge</div>
      <div style="display: flex; justify-content: center; width: 100px; overflow-x: auto"><span style="flex: none; width: 300px">Before the start of its scroller</span></div>
      <div style="position: relative; width: 50px; height: 20px"><div style="overflow: hidden; width: 50px"><span style="position: absolute; white-space: nowrap">Escapes a static clip</span></div></div>
      <span class="sr">Read by screen readers only, never shown</span>
      <div style="position: fixed; top: 200px; left: 0; width: 120px"><button>Menu item one</button><br><button>Menu item two</button><br><button>Menu item three</button><br><button>Menu item four</button><br><button>Menu item five</button></div>
      <button style="position: fixed; right: 0; bottom: 10px">Under the bar</button>
      <div style="display: flex; flex-direction: column; height: 10px"><div style="height: 30px; flex: none"></div><textarea aria-label="Squeezed box" style="overflow: hidden; height: 30px; padding: 0; border: 0">Shut</textarea></div>
      <div role="dialog" aria-label="Panel"><input aria-label="Long value" style="width: 80px" value="A value far too long for its box"><textarea aria-label="Grown box" rows="1" style="overflow: hidden; height: 20px; width: 80px">Line one of several lines that need more room than one row</textarea></div>
      <div class="bar"></div>
    `)
    const found = [...(await clippedContent(page)), ...(await danglingLines(page)), ...(await hiddenFocusRings(page))].join('\n')
    expect(found).toContain('text "Clipped without an ellipsis" is cut off')
    expect(found).toContain('text "Shortened with no way to read it" is cut off')
    expect(found).not.toContain('Shortened with the whole text in a title')
    expect(found).toContain('button "Half hidden button"')
    expect(found).toContain('text "Off the right edge"')
    expect(found).toContain('text "Before the start of its scroller" starts')
    expect(found).not.toContain('Escapes a static clip')
    expect(found).not.toContain('Read by screen readers only')
    expect(found).toContain('button "Menu item five" runs')
    expect(found).toContain('button "Under the bar" is covered')
    expect(found).not.toContain('Ring in the clear')
    expect(found).toContain('focus ring of button "Ring under the next row" is 100% hidden along its bottom side')
    expect(found).toContain('row "aRow left open"')
    expect(found).not.toContain('Row closed by a line')
    expect(found).toContain('the value of input "Long value" is cut off')
    expect(found).toContain('the text in textarea "Grown box" is cut off')
    expect(found).toContain('textarea "Squeezed box" is squeezed to 0px tall')
  })
})
