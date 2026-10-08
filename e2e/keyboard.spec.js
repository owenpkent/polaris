import { test, expect } from './fixtures.js'
import { createTask, isPhone, openTask, openView } from './support.js'

// The keyboard-only sweep (initiatives/ui-ux-testing.md, phase 7): from page load, Tab reaches
// every control the pointer can, in visual order, and no Tab stop is unlabelled. Then Menu.jsx's
// roving focus with the arrow keys, Home, and End, and the `?` legend.

const VIEWS = ['mytasks', 'inbox', 'board', 'goals', 'projects', 'checklists', 'rules', 'digest', 'github', 'settings']

// The Board's lanes are side-by-side columns that scroll sideways as a strip (src/index.css,
// .board-lanes), and Tab walks one lane top to bottom before starting the next at the top again.
// That is the right reading order for a board and can never satisfy a top-then-left rule.
const NO_VISUAL_ORDER = new Set(['board'])

const TAB_CAP = 150

// What a pointer could use inside main: the same visibility rules as smallTargets in support.js.
const POINTER_SELECTOR =
  'button:not(:disabled), [role="button"], a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [role="menuitem"]'

// Remembers the visible pointer-usable elements in main, so the sweep can later say which of them
// it never reached. Elements are kept on the page's window, since a locator cannot hold a node
// across evaluate calls.
async function rememberPointerSet(page) {
  return page.evaluate((selector) => {
    const out = []
    for (const el of document.querySelectorAll(`main ${selector}`)) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      out.push(el)
    }
    window.__ccPointerSet = out
    window.__ccStops = []
    return out.length
  }, POINTER_SELECTOR)
}

function describeActive() {
  const el = document.activeElement
  if (!el || el === document.body || el === document.documentElement) return null
  const stops = window.__ccStops
  let index = stops.indexOf(el)
  const seen = index >= 0
  if (!seen) index = stops.push(el) - 1
  const labelText = () => {
    const labels = el.labels ? Array.from(el.labels) : []
    return labels.map((l) => l.textContent.trim()).find(Boolean) || ''
  }
  const name = el.getAttribute('aria-label') || el.textContent.trim() || labelText()
  const role = el.getAttribute('role') || (el.tagName.toLowerCase() === 'input' ? `input[${el.type}]` : el.tagName.toLowerCase())
  // Layout position, not screen position: focusing a control scrolls the page and any scrolling
  // ancestor (the GitHub table scrolls sideways inside its card on a phone), so the viewport
  // coordinates of two stops are not comparable. Adding back every ancestor's scroll offset gives
  // each stop its place in the layout, which is what visual order means.
  const r = el.getBoundingClientRect()
  let scrollX = window.scrollX
  let scrollY = window.scrollY
  // A control fixed to the viewport (the phone's floating New task button, the tab bar) has no
  // place in the content's order: it is wherever the screen is.
  let fixed = false
  for (let node = el; node; node = node.parentElement) {
    const position = getComputedStyle(node).position
    if (position === 'fixed' || position === 'sticky') fixed = true
    if (node !== el) {
      scrollX += node.scrollLeft || 0
      scrollY += node.scrollTop || 0
    }
  }
  return {
    index,
    seen,
    role,
    name: name.slice(0, 60),
    top: r.top + scrollY,
    left: r.left + scrollX,
    bottom: r.bottom + scrollY,
    fixed,
    inMain: !!el.closest('main'),
  }
}

// Presses Tab until focus comes back to the first stop, leaves the document, or the cap is hit.
async function tabSweep(page) {
  const stops = []
  for (let i = 0; i < TAB_CAP; i++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(describeActive)
    if (!stop) break
    if (stops.length && stop.index === stops[0].index) break
    stops.push(stop)
  }
  return stops
}

async function unreachedPointerTargets(page) {
  return page.evaluate(() => {
    const reached = new Set(window.__ccStops)
    // A radio group is one Tab stop, and the arrow keys move within it, so reaching one radio of
    // a group reaches all of them.
    const reachedGroups = new Set(window.__ccStops.filter((el) => el.type === 'radio' && el.name).map((el) => el.name))
    return window.__ccPointerSet
      .filter((el) => !reached.has(el))
      .filter((el) => !(el.type === 'radio' && reachedGroups.has(el.name)))
      .map((el) => {
        const label = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40) || el.tagName.toLowerCase()
        return `${el.tagName.toLowerCase()} "${label}"`
      })
  })
}

// Each stop sits below the previous one, or on the same line (tops within 4px) and to its right.
function visualOrderBreaks(stops) {
  const out = []
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1]
    const cur = stops[i]
    // Two stops share a line when their vertical extents overlap: a row's title link and its
    // Reject button sit on one row although their tops differ by a few pixels. On a line the
    // next stop must not be to the left; equal positions are fine, since a control nested in a
    // row button (the Complete checkbox) starts where the row starts.
    const sameLine = cur.top < prev.bottom && prev.top < cur.bottom
    const ok = sameLine ? cur.left >= prev.left : cur.top > prev.top
    if (!ok) {
      out.push(`stop ${i} ${cur.role} "${cur.name}" (${Math.round(cur.left)},${Math.round(cur.top)}) comes after ${prev.role} "${prev.name}" (${Math.round(prev.left)},${Math.round(prev.top)})`)
    }
  }
  return out
}

test.describe('keyboard-only sweep', { tag: ['@a11y'] }, () => {
  for (const view of VIEWS) {
    test(`${view}: Tab reaches every pointer target in main, each with a name, in visual order`, async ({ page }) => {
      await openView(page, view)
      const pointerCount = await rememberPointerSet(page)
      expect(pointerCount, 'main has no pointer targets to reach').toBeGreaterThan(0)

      const stops = await tabSweep(page)
      expect(stops.length, 'Tab reached nothing').toBeGreaterThan(0)
      expect(stops.length, `the sweep hit the ${TAB_CAP} press cap`).toBeLessThan(TAB_CAP)

      const unnamed = stops.filter((s) => !s.name).map((s, i) => `stop ${i} ${s.role}`)
      expect(unnamed, 'Tab stops without an accessible name').toEqual([])

      expect(await unreachedPointerTargets(page), 'pointer targets in main that Tab never reached').toEqual([])

      if (!NO_VISUAL_ORDER.has(view)) {
        // Visual order is a claim about the content. The top bar and the phone tab bar sit
        // outside main, and the tab bar is fixed to the bottom of the viewport, over whatever
        // content row happens to be last on screen.
        expect(visualOrderBreaks(stops.filter((stop) => stop.inMain && !stop.fixed)), 'Tab stops out of visual order').toEqual([])
      }
    })
  }
})

test.describe('roving focus in a menu', { tag: ['@a11y'] }, () => {
  // Menu.jsx (useRovingFocus) handles ArrowDown, ArrowUp, Home, and End; its Popover handles
  // Escape, closing the menu and returning focus to the trigger. The Sort menu's items come from
  // SORT_FIELDS in viewState.js, each field ascending then descending.
  test('the Sort menu moves with ArrowDown, ArrowUp, End, and Home, and Escape returns focus', async ({ page }) => {
    await openView(page)
    const sort = page.getByRole('button', { name: 'Sort' })
    await sort.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Sort tasks' })
    await expect(menu).toBeVisible()
    const first = menu.getByRole('menuitemcheckbox', { name: 'Due date (ascending)' })
    const second = menu.getByRole('menuitemcheckbox', { name: 'Due date (descending)' })
    const last = menu.getByRole('menuitemcheckbox', { name: 'Name (descending)' })

    await expect(first).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(second).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(first).toBeFocused()
    await page.keyboard.press('End')
    await expect(last).toBeFocused()
    await page.keyboard.press('Home')
    await expect(first).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(sort).toBeFocused()
  })

  test('ArrowDown wraps from the last item to the first, and ArrowUp from the first to the last', async ({ page }) => {
    await openView(page)
    await page.getByRole('button', { name: 'Sort' }).focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Sort tasks' })
    const first = menu.getByRole('menuitemcheckbox', { name: 'Due date (ascending)' })
    const last = menu.getByRole('menuitemcheckbox', { name: 'Name (descending)' })
    await expect(first).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(last).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(first).toBeFocused()
    await page.keyboard.press('Escape')
  })
})

test.describe('the ? legend', { tag: ['@a11y'] }, () => {
  test('? opens the keyboard shortcuts dialog on My tasks, Escape closes it and focus stays put', async ({ page }) => {
    await openView(page)
    const row = page.getByRole('button', { name: 'Open Reply to accessibility audit feedback', exact: true })
    await row.focus()
    await page.keyboard.press('?')
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(row).toBeFocused()
  })

  // The toggle ignores a `?` typed into a field (MyTasksTab.jsx). The toolbar's Add task input is
  // a desktop control; the phone tier creates tasks through a sheet instead.
  test('? typed into a text field is text, not the legend', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'the inline Add task input is a desktop control')
    await openView(page)
    await page.getByRole('toolbar', { name: 'Tasks' }).getByRole('button', { name: 'Add task' }).click()
    const field = page.getByRole('textbox', { name: 'New task name' })
    await expect(field).toBeFocused()
    await page.keyboard.press('?')
    await expect(field).toHaveValue('?')
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
})

test.describe('the due date box in the task panel', { tag: ['@a11y'] }, () => {
  // DueDateMenu.jsx is portalled to <body>, outside the panel's focus trap (TaskDetailPanel.jsx).
  // Tab has to move between the date box's own segments, and typing a new year has to reach
  // all four digits: Chromium fires change after the first one, which must not be saved.
  test('Tab stays in the date box, a typed digit waits for Enter to save, and Escape returns to the trigger', async ({ page, request }, testInfo) => {
    test.skip(isPhone(testInfo), 'the date box has keyboard segments on the desktop tier')
    const title = await createTask(request, testInfo, 'due year', { dueAt: '2026-10-08' })
    await openView(page)
    await openTask(page, title)
    const trigger = page.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: /^Due date, / })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Due date' })
    await expect(menu).toBeVisible()
    const input = menu.getByLabel('Date')
    await input.focus()
    await expect(input).toBeFocused()

    // Where focus is and what the box holds after each key, kept with the test so a run on
    // another browser explains itself: Edge on Windows does not give the box the Tab stops
    // Chromium on Linux does.
    const trace = []
    async function note(step) {
      trace.push({ step, ...(await page.evaluate(() => {
        const el = document.activeElement
        return { active: el?.tagName + (el?.type ? `[${el.type}]` : ''), label: el?.getAttribute?.('aria-label') || el?.textContent?.slice(0, 40) || '', value: el?.value ?? null }
      })) })
    }

    // Tab from the first segment moves to the next one, and Shift+Tab back, with focus never
    // leaving the box (the panel's trap used to pull it to Mark complete).
    await page.keyboard.press('Tab')
    await note('Tab')
    await expect(input).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await note('Shift+Tab')
    await expect(input).toBeFocused()

    // One digit into whichever segment is focused changes the box's value (Chromium fires change
    // at once, which used to save the half-typed date and close the menu). Nothing is saved until
    // Enter, which saves what the box shows, once. The unit tests cover the year-0002 case.
    const saved = []
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().includes('/api/tasks/')) saved.push(req.postDataJSON())
    })
    await page.keyboard.type('2')
    await note('type 2')
    await testInfo.attach('focus trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' })
    await expect(menu).toBeVisible()
    expect(saved).toEqual([])
    const typed = await input.inputValue()
    expect(typed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(typed).not.toBe('2026-10-08')
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect.poll(() => saved.map((body) => body.dueAt)).toEqual([typed])

    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible()
  })
})
