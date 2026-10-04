import { test, expect } from './fixtures.js'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { VIEWS, createTask, emptyRequest, failRequest, failureBanner, gotoView, holdRequest, openTask, openView } from './support.js'

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
  writeFileSync(join(DIRS.status, `${name}.json`), JSON.stringify({ name, view, state, variant: variant(testInfo), status }))
  return status
}

// The digest names every task and goal by its id, and the seed makes those afresh for each run.
// Rather than masking the digest, which would hide its headings, text, and link colors from the
// comparison, the response is rewritten on its way to the page: each id becomes t_0000000001,
// t_0000000002, and so on in order of first appearance, with the same prefix and length as the
// real one. The digest then renders the same text every run and stays fully visible in the shot.
async function stabiliseDigestIds(page) {
  await page.route('**/api/digest', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    const seen = new Map()
    body.markdown = String(body.markdown ?? '').replace(/\b([a-z])_[0-9a-z]{10}\b/g, (id, prefix) => {
      if (!seen.has(id)) seen.set(id, `${prefix}_${String(seen.size + 1).padStart(10, '0')}`)
      return seen.get(id)
    })
    await route.fulfill({ response, json: body })
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

  // A task claimed through "Assign to AI" (or set up that way from the start, same field):
  // the chip and the Take back button next to Mark complete. Made with its own task, not the
  // shared seeded project, since this test changes data.
  test('mytasks: panel assign to AI', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'assign to ai', { assignee: 'claude-code' })
    await openView(page)
    await openTask(page, title)
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await expect(dialog.getByText('Assigned to claude-code')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Take back' })).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'panel-assign-to-ai')
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

  test('mytasks: due menu', async ({ page }, testInfo) => {
    await openView(page)
    await page.getByRole('button', { name: 'Change due date for Reply to accessibility audit feedback' }).click()
    await expect(page.getByRole('menu', { name: 'Due date for Reply to accessibility audit feedback' })).toBeVisible()
    await shot(page, testInfo, 'mytasks', 'due-menu')
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

  test('mytasks: drawer', async ({ page }, testInfo) => {
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await drawer.getByRole('button', { name: 'More' }).click()
    await shot(page, testInfo, 'mytasks', 'drawer')
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

  for (const view of ['board', 'goals', 'projects', 'rules', 'github']) {
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

  test('connection: page', async ({ page }, testInfo) => {
    await openView(page, 'connection')
    // The backup folder is a scratch directory with a random name, and the newest copy carries
    // the time the test server started.
    const values = page.getByText(/^(Folder|Newest copy)$/).locator('xpath=following-sibling::span')
    await shot(page, testInfo, 'connection', 'page', [values])
  })
})
