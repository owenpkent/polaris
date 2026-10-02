// @vitest-environment node
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
