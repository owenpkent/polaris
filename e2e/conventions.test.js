// @vitest-environment node
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Keeps the rules for UI tests (CLAUDE.md, initiatives/ui-ux-testing.md) from rotting. Runs with
// the dashboard unit tests, so the pre-push hook and the fast CI job catch a slip before the
// browser suite ever runs.
const dir = dirname(fileURLToPath(import.meta.url))
const specs = readdirSync(dir).filter((f) => f.endsWith('.spec.js'))
const helpers = ['support.js', 'fixtures.js']

describe('UI test conventions', () => {
  it('has spec files to check', () => {
    expect(specs.length).toBeGreaterThan(0)
  })

  for (const file of [...specs, ...helpers]) {
    const text = readFileSync(join(dir, file), 'utf8')

    it(`${file} selects by accessible name, never by class or id`, () => {
      // A leading dot or hash is a class or id. '..' is an XPath step to the parent, which is fine.
      const bad = text.match(/(locator|\$|\$\$)\(\s*['"`][.#](?!\.)[^'"`]*['"`]/g) || []
      expect(bad, 'CSS class or id selectors').toEqual([])
    })
  }

  for (const file of specs) {
    const text = readFileSync(join(dir, file), 'utf8')

    it(`${file} imports test and expect from fixtures.js`, () => {
      expect(text).toContain("from './fixtures.js'")
      expect(text).not.toMatch(/import \{[^}]*\btest\b[^}]*\} from '@playwright\/test'/)
    })

    it(`${file} tags every test.describe and every top-level test`, () => {
      const untagged = text.match(/^(test\.describe|test)\(\s*['"`][^'"`]*['"`]\s*,\s*(async|\(\))/gm) || []
      expect(untagged, 'test.describe or test without { tag }').toEqual([])
      expect(text).toMatch(/tag: \[/)
    })
  }
})

// Which project runs which test is decided by tags against the grep and grepInvert of each project
// in playwright.config.js, and a green run says nothing about what was left out: a group tagged
// for an extra project (@narrow, @landscape) is excluded from desktop and phone. So the suite's
// own list, as Playwright selects it, is checked for the cases that must run at every size.
describe('UI test selection', () => {
  const sizes = ['desktop', 'phone', 'phone-320', 'phone-landscape']
  const listed = execSync(`npx playwright test --list ${sizes.map((p) => `--project ${p}`).join(' ')}`, {
    cwd: join(dir, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  })
  const titles = listed.split(/\r?\n/).filter((line) => line.includes(' \u203a ')).map((line) => line.trim())
  const inProject = (project, text) => titles.filter((t) => t.startsWith(`[${project}]`) && t.includes(text))

  it('lists tests', () => {
    expect(titles.length).toBeGreaterThan(0)
  })

  for (const project of sizes) {
    it(`${project} runs the cut-off checks on a view, the task panel, and the long names`, () => {
      const clipping = (text) => inProject(project, 'clipping.spec.js').filter((t) => t.includes(text))
      expect(clipping('\u203a nothing is cut off \u203a My tasks'), 'a view').not.toEqual([])
      expect(clipping('\u203a nothing is cut off \u203a the task panel'), 'the task panel').not.toEqual([])
      expect(clipping('\u203a nothing is cut off with the task panel open \u203a'), 'the panel from each view').not.toEqual([])
      expect(clipping('\u203a nothing is cut off with long names \u203a'), 'long names').not.toEqual([])
    })
  }

  it('only the desktop project runs the widths between the breakpoint and the desktop width', () => {
    const between = (project) => inProject(project, 'between the breakpoint and the desktop width')
    expect(between('desktop')).not.toEqual([])
    for (const project of ['phone-320', 'phone-landscape']) expect(between(project), project).toEqual([])
  })

  it('a test tagged for an extra project stays out of desktop and phone', () => {
    for (const project of ['desktop', 'phone']) {
      expect(inProject(project, 'narrow.spec.js'), `${project} and @narrow`).toEqual([])
    }
  })
})
