// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The `?` legend (KeyboardLegendDialog.jsx) must list every shortcut the app handles app-wide
// (initiatives/ui-ux-testing.md, phase 7). App-wide means a keydown listener on window or
// document: a key read inside such a listener is a shortcut the user can press anywhere on the
// view. Keys read by an element's own handler (a text field's Enter, a task row's Enter, a
// resize handle's arrows) are that element's behaviour, not a shortcut, and Menu.jsx is left out
// because its keys are menu navigation.

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..')

const LEGEND_FILE = join(here, 'KeyboardLegendDialog.jsx')
const EXCLUDED_FILES = new Set(['command-center/Menu.jsx'])
// Navigation keys, never shortcuts: NavDrawer's focus trap reads Tab, the menus read arrows.
const NAVIGATION_KEYS = new Set(['Tab', 'Shift', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
// The legend spells Escape the way the key cap does.
const LEGEND_SPELLINGS = { Esc: 'Escape' }

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

// The keys the legend lists: each `['Key', 'what it does']` row of SHORTCUTS.
export function legendKeys(text = readFileSync(LEGEND_FILE, 'utf8')) {
  const start = text.indexOf('const SHORTCUTS = [')
  const end = text.indexOf('\n]', start)
  if (start < 0 || end < 0) throw new Error('KeyboardLegendDialog.jsx has no SHORTCUTS list')
  const block = text.slice(start, end)
  return [...block.matchAll(/\[\s*'([^']+)'\s*,\s*'[^']*'\s*\]/g)].map((m) => LEGEND_SPELLINGS[m[1]] || m[1])
}

// The body of the `function name(` declaration at `head` in `text`, found by matching braces and
// skipping string literals and comments, so a brace inside a string does not end it early.
function functionBodyAt(text, head) {
  const open = text.indexOf('{', head)
  if (open < 0) return null
  let depth = 0
  let i = open
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      i = text.indexOf('\n', i)
      if (i < 0) return null
      continue
    }
    if (ch === '/' && next === '*') {
      i = text.indexOf('*/', i) + 2
      if (i < 2) return null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') j++
        j++
      }
      i = j + 1
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
    i++
  }
  return null
}

// Every declaration of `function name(` in `text`: a file may declare one `onKeyDown` per effect.
function functionBodies(text, name) {
  const out = []
  const needle = `function ${name}(`
  let at = text.indexOf(needle)
  while (at >= 0) {
    const body = functionBodyAt(text, at)
    if (body) out.push(body)
    at = text.indexOf(needle, at + needle.length)
  }
  return out
}

// The keys read inside every keydown listener on window or document, per file.
export function appWideKeys(files = walk(srcDir)) {
  const keys = new Map() // key -> [file, ...]
  for (const file of files) {
    const rel = relative(srcDir, file).split('\\').join('/')
    if (EXCLUDED_FILES.has(rel)) continue
    const text = readFileSync(file, 'utf8')
    const listeners = [...text.matchAll(/\b(?:window|document)\.addEventListener\(\s*'keydown'\s*,\s*(\w+)/g)].map((m) => m[1])
    for (const name of new Set(listeners)) {
      const bodies = functionBodies(text, name)
      if (bodies.length === 0) throw new Error(`${rel}: keydown listener ${name} is not a named function declaration`)
      for (const m of bodies.join('\n').matchAll(/\bkey\s*(?:===|!==)\s*'([^']+)'/g)) {
        const key = m[1]
        if (NAVIGATION_KEYS.has(key)) continue
        if (!keys.has(key)) keys.set(key, [])
        if (!keys.get(key).includes(rel)) keys.get(key).push(rel)
      }
    }
  }
  return keys
}

describe('the keyboard legend', () => {
  it('reads the legend and the handlers rather than an empty list', () => {
    const legend = legendKeys()
    expect(legend).toContain('Escape')
    expect(legend).toContain('?')
    const handled = appWideKeys()
    expect(handled.has('Escape'), 'no window or document keydown listener reads Escape').toBe(true)
    expect(handled.get('?'), 'the ? toggle').toContain('command-center/MyTasksTab.jsx')
  })

  // The inbox's j/k/a/r listener (InboxTab.jsx) is a window keydown listener with no entry in the
  // legend, which says it lists "the keyboard shortcuts this page has". When the legend gains
  // them, this expectation becomes [] and the SUSPECTED BUG note goes.
  it('SUSPECTED BUG, found 2026-09-26: lists every app-wide shortcut except the inbox letters j, k, a, and r', () => {
    const legend = new Set(legendKeys())
    const handled = appWideKeys()
    const missing = [...handled.keys()].filter((key) => !legend.has(key)).sort()
    expect(missing, `app-wide keys the legend does not list: ${missing.map((k) => `${k} (${handled.get(k).join(', ')})`).join('; ')}`).toEqual(['a', 'j', 'k', 'r'])
    for (const key of missing) expect(handled.get(key)).toEqual(['command-center/InboxTab.jsx'])
  })
})
