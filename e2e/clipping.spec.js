import { test, expect } from './fixtures.js'
import { VIEWS, clippedContent, createTask, danglingLines, hiddenFocusRings, fakeUpdate, isPhone, openTask, openView } from './support.js'

// Nothing is cut off (CONTRIBUTING.md, "Nothing is cut off"): every view, panel, sheet, and menu
// is checked with clippedContent (e2e/support.js), which fails on text a box hides, content off
// the side of the screen or out of a scroll box's reach, and a control that cannot be scrolled
// into full view or has something drawn over it. The tags run it in every viewport project:
// desktop and phone (@a11y), 320px (@narrow), and a phone turned sideways (@landscape). The
// widths between the breakpoint and the desktop viewport, where a sidebar and a full toolbar
// share the least room, are covered by the last group.

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

test.describe('nothing is cut off', { tag: ['@a11y', '@narrow', '@landscape'] }, () => {
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
  })
})
