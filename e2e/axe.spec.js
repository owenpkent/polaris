import AxeBuilder from '@axe-core/playwright'
import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures.js'
import { openView, openTask } from './support.js'

// The automated accessibility audit (initiatives/ui-ux-testing.md, phase 2): axe-core over every
// view in its resting state and over the panels, drawer, menus, and forms that open on top of
// them, at both widths and, through the @theme tag, in both themes.
//
// A serious or critical violation fails the test. A moderate or minor one is attached to the test
// and printed, and does not fail until the list has been read for a while. A violation that is
// judged wrong, or accepted for a reason, goes in e2e/axe-allow.json as { rule, states,
// selector?, target?, html?, reason, projects? }: `rule` is the axe rule id; `states` the names
// of the audited states it is expected in (the `state` strings below), and in every one of them
// it must match something or that audit fails, so the list cannot outlive the thing it excuses
// (checked inside the audit, which holds whatever workers and shards the run is split into);
// `selector` a CSS selector the element itself must match, checked in the page (the steady way
// to name an element, since axe builds its own selector from whatever makes the element unique,
// an aria-label one run and a class the next, and truncates the markup it reports); `target` a
// fragment of axe's selector; `html` a fragment of the reported markup; `projects` the project
// names it applies to (all when left out).
//
// Under forced colours (the desktop-hc project) axe cannot see the system colours Edge paints
// with, so its colour-contrast results there are advisory; that project exists for focus rings,
// control edges, and selected states, which the other checks cover.
//
// This complements the hand-written checks in accessibility.spec.js rather than replacing them:
// axe's target-size rule stops at 24px, and the bar here is 44px.

const VIEWS = ['mytasks', 'inbox', 'board', 'goals', 'projects', 'threads', 'rules', 'digest', 'github', 'connection']
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']
const FAILS = new Set(['serious', 'critical'])
const ALLOW = JSON.parse(readFileSync(new URL('./axe-allow.json', import.meta.url), 'utf8'))

async function allowed(page, violation, node, target, project) {
  for (const a of ALLOW) {
    if (a.rule !== violation.id) continue
    if (a.projects && !a.projects.includes(project)) continue
    if (a.target && !target.includes(a.target)) continue
    if (a.html && !String(node.html || '').includes(a.html)) continue
    if (a.selector) {
      const matches = await page.evaluate(
        ([axeTarget, selector]) => {
          try {
            const el = document.querySelector(axeTarget)
            return Boolean(el && el.matches(selector))
          } catch {
            return false
          }
        },
        [String(node.target[0]), a.selector]
      )
      if (!matches) continue
    }
    return a
  }
  return null
}

async function audit(page, testInfo, state) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const forcedColours = testInfo.project.use.forcedColors === 'active'
  const failing = []
  const advisory = []
  const used = new Set()
  for (const violation of results.violations) {
    for (const node of violation.nodes) {
      const target = node.target.join(' ')
      const entry = await allowed(page, violation, node, target, testInfo.project.name)
      if (entry) {
        used.add(entry)
        continue
      }
      const line = `${violation.id} [${violation.impact}] ${target}: ${violation.help} (${violation.helpUrl})`
      const fails = FAILS.has(violation.impact) && !(forcedColours && violation.id === 'color-contrast')
      ;(fails ? failing : advisory).push(line)
    }
  }
  if (advisory.length) {
    const body = advisory.join('\n')
    await testInfo.attach(`axe advisory ${state}`, { body, contentType: 'text/plain' })
    console.log(`axe advisory, ${state} [${testInfo.project.name}]:\n${body}`)
  }
  expect(failing, `axe violations, ${state}`).toEqual([])
  const stale = ALLOW.filter(
    (a) => a.states.includes(state) && (!a.projects || a.projects.includes(testInfo.project.name)) && !used.has(a)
  )
  expect(stale.map((a) => `${a.rule} ${a.selector || a.target || a.html}`), `allow entries that matched nothing in ${state}`).toEqual([])
}

test.describe('axe', { tag: ['@a11y', '@theme'] }, () => {
  for (const view of VIEWS) {
    test(`${view} at rest`, async ({ page }, testInfo) => {
      await openView(page, view)
      await audit(page, testInfo, `${view} at rest`)
    })
  }

  test('the navigation drawer', async ({ page }, testInfo) => {
    await openView(page)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible()
    await audit(page, testInfo, 'navigation drawer open')
  })

  test('the task details panel', async ({ page }, testInfo) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    await audit(page, testInfo, 'task details panel open')
  })

  test('the task panel\'s goal menu', async ({ page }, testInfo) => {
    await openView(page)
    await openTask(page, 'Reply to accessibility audit feedback')
    await page.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Add to goal' }).click()
    await expect(page.getByRole('menu', { name: 'Add to goal' }).getByRole('menuitem').first()).toBeVisible()
    await audit(page, testInfo, 'goal menu open')
  })

  test('the sort menu', async ({ page }, testInfo) => {
    await openView(page)
    await page.getByRole('button', { name: 'Sort' }).click()
    await expect(page.getByRole('menu', { name: 'Sort tasks' })).toBeVisible()
    await audit(page, testInfo, 'sort menu open')
  })

  test('the theme menu', async ({ page }, testInfo) => {
    await openView(page)
    await page.getByRole('button', { name: 'Theme' }).click()
    await audit(page, testInfo, 'theme menu open')
  })

  test('the inbox accept form', async ({ page }, testInfo) => {
    await openView(page, 'inbox')
    await page.getByRole('button', { name: 'Accept' }).last().click()
    await expect(page.getByRole('button', { name: 'Accept as task' })).toBeVisible()
    await audit(page, testInfo, 'inbox accept form open')
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('the new goal form', async ({ page }, testInfo) => {
    await openView(page, 'goals')
    await page.getByRole('toolbar', { name: 'Goals' }).getByRole('button', { name: 'Add goal' }).click()
    await expect(page.getByRole('form', { name: 'New goal' })).toBeVisible()
    await audit(page, testInfo, 'new goal form open')
  })

  test('the new project form', async ({ page }, testInfo) => {
    await openView(page, 'projects')
    await page.getByRole('toolbar', { name: 'Projects' }).getByRole('button', { name: 'New project' }).click()
    await expect(page.getByRole('form', { name: 'New project' })).toBeVisible()
    await audit(page, testInfo, 'new project form open')
  })

  // The Rules view shows its New rule form at rest, so the audit of the view covers it.
})
