// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Turns CLAUDE.md's "no drag-only or hover-only interactions" and "no emoji anywhere / no em
// dashes" rules, and the matching Phase 7 bullets in initiatives/ui-ux-testing.md (No hover-only,
// No drag-only), into unit tests over the dashboard source. Shape follows e2e/conventions.test.js:
// read the file, match a plain pattern, name the file and line in the failure.

const srcDir = dirname(fileURLToPath(import.meta.url))
const root = join(srcDir, '..')
const SKIP_DIRS = new Set(['node_modules', 'dist', '.shots', '.playwright'])

// -- allow list ---------------------------------------------------------------------------------
// { file, rule, reason }, file relative to the repo root. The "allow list entries all still
// apply" test below fails if an entry stops matching a real violation, so the list cannot rot.
const ALLOW_LIST = [
  {
    file: 'src/command-center/ColumnHeader.jsx',
    rule: 'drag-only',
    reason:
      'SUSPECTED BUG, found 2026-09-26: setPointerCapture drives the column-width drag handle, which also has an ArrowLeft/ArrowRight keyboard nudge and a widen/narrow/reset menu, so this may be a false positive the owner should confirm.',
  },
]

function isAllowed(file, rule) {
  return ALLOW_LIST.some((entry) => entry.file === file && entry.rule === rule)
}

// -- file walking ---------------------------------------------------------------------------------
function walk(dir, matches, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, matches, acc)
    else if (matches(entry.name)) acc.push(full)
  }
  return acc
}

function relPath(absPath) {
  return relative(root, absPath).split(sep).join('/')
}

// src/**/*.jsx and src/**/*.js, excluding tests: the surface rules 1 and 2 scan.
const componentFiles = walk(
  join(root, 'src'),
  (name) => (name.endsWith('.jsx') || name.endsWith('.js')) && !name.endsWith('.test.jsx') && !name.endsWith('.test.js')
)

// Every js/jsx/css file under src/, tests included: the surface rule 4 scans (emoji, dashes).
const allSrcFiles = walk(join(root, 'src'), (name) => name.endsWith('.jsx') || name.endsWith('.js') || name.endsWith('.css'))

function collectMarkdownFiles() {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(root, entry.name))
  }
  for (const sub of ['initiatives', 'docs', 'command-center']) {
    const subDir = join(root, sub)
    if (existsSync(subDir)) walk(subDir, (name) => name.endsWith('.md'), files)
  }
  const ignored = gitIgnored(files)
  return files.filter((file) => !ignored.has(file))
}

// The files git ignores among `files` (a scratch copy, a private note): not part of the repo, so
// the docs sweep leaves them alone, or the pre-push hook fails on one machine and passes on the
// rest. `git check-ignore` exits 1 when nothing is ignored; with no git at all, nothing is.
function gitIgnored(files) {
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], { cwd: root, input: files.map(relPath).join('\n'), encoding: 'utf8' })
    return new Set(out.split('\n').filter(Boolean).map((p) => join(root, p)))
  } catch {
    return new Set()
  }
}
const markdownFiles = collectMarkdownFiles()

// -- matchers (the same functions the sweep and the positive controls both call) -----------------

// Rule 1: no drag-only interaction.
const DRAG_PATTERN = /\b(draggable|onDragStart|onDrag|onDrop|setPointerCapture|ondragstart)\b/

function findDragMarkers(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    const m = line.match(DRAG_PATTERN)
    if (m) hits.push({ line: i + 1, match: m[0] })
  })
  return hits
}

// Rule 2: no hover-only reveal in JSX.
const HOVER_HANDLERS = ['onMouseEnter', 'onMouseOver', 'onMouseLeave']

function findHoverHandlersJsx(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    for (const handler of HOVER_HANDLERS) {
      if (line.includes(handler)) hits.push({ line: i + 1, handler })
    }
  })
  return hits
}

function hasFocusPath(text) {
  return /\bonFocus\b|\bonFocusCapture\b/.test(text)
}

// Rule 3: no hover-only reveal in CSS. Simple parse: split on `}`, selector before the last `{`
// in the chunk, declarations after it. No CSS parser dependency.
function parseCssRules(text) {
  const rules = []
  const parts = text.split('}')
  let offset = 0
  for (let i = 0; i < parts.length - 1; i++) {
    const chunk = parts[i]
    const braceIdx = chunk.lastIndexOf('{')
    if (braceIdx !== -1) {
      const selector = chunk.slice(0, braceIdx).trim()
      const declarations = chunk.slice(braceIdx + 1).trim()
      const line = text.slice(0, offset + braceIdx).split('\n').length
      rules.push({ selector, declarations, line })
    }
    offset += chunk.length + 1
  }
  return rules
}

function splitSelectors(selector) {
  return selector.split(',').map((s) => s.trim()).filter(Boolean)
}

const REVEAL_PROPS = /(display|visibility|opacity)\s*:/

function findHoverOnlyCss(text) {
  const rules = parseCssRules(text)
  const allSelectorParts = new Set()
  for (const rule of rules) {
    for (const part of splitSelectors(rule.selector)) allSelectorParts.add(part)
  }
  const violations = []
  for (const rule of rules) {
    const hoverParts = splitSelectors(rule.selector).filter((part) => part.includes(':hover'))
    if (hoverParts.length === 0) continue
    if (!REVEAL_PROPS.test(rule.declarations)) continue
    const covered = hoverParts.every(
      (part) =>
        allSelectorParts.has(part.replace(/:hover/g, ':focus-within')) ||
        allSelectorParts.has(part.replace(/:hover/g, ':focus-visible'))
    )
    if (!covered) violations.push(rule)
  }
  return violations
}

// Rule 4: no emoji, no em dash or en dash.
// Character codes, not literal characters or \u escapes, so this source file stays plain ASCII
// and passes its own rule 4.
const COPYRIGHT_SIGN = String.fromCharCode(169)
const REGISTERED_SIGN = String.fromCharCode(174)
const TRADEMARK_SIGN = String.fromCharCode(8482)
const EM_DASH = String.fromCharCode(8212)
const EN_DASH = String.fromCharCode(8211)
const CHECK_MARK_EMOJI = String.fromCodePoint(9989)

const EMOJI_RE = /\p{Extended_Pictographic}/u
const EMOJI_EXCLUDE = new Set(['#', '*', COPYRIGHT_SIGN, REGISTERED_SIGN, TRADEMARK_SIGN])

function findEmoji(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    for (const ch of line) {
      if (/[0-9]/.test(ch) || EMOJI_EXCLUDE.has(ch)) continue
      if (EMOJI_RE.test(ch)) hits.push({ line: i + 1, char: ch })
    }
  })
  return hits
}

const DASH_RE = new RegExp(`[${EM_DASH}${EN_DASH}]`)

function findDashes(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    if (DASH_RE.test(line)) hits.push({ line: i + 1 })
  })
  return hits
}

// -- rule 1: no drag-only interaction -------------------------------------------------------------

describe('no drag-only interaction (CLAUDE.md: no drag-only or hover-only interactions)', () => {
  it('positive control: findDragMarkers reports a planted draggable card', () => {
    const fake = ['function Card() {', '  return <div draggable onDragStart={onDrag}>x</div>', '}'].join('\n')
    const hits = findDragMarkers(fake)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].line).toBe(2)
  })

  it('BoardTab.jsx stays clean: it moves cards through a Move menu, not a drag', () => {
    const file = componentFiles.find((f) => relPath(f) === 'src/command-center/BoardTab.jsx')
    expect(file, 'src/command-center/BoardTab.jsx should exist').toBeTruthy()
    const text = readFileSync(file, 'utf8')
    expect(findDragMarkers(text), 'src/command-center/BoardTab.jsx should have no drag-only markers').toEqual([])
    expect(text, 'src/command-center/BoardTab.jsx should render a Move menu').toMatch(/MoveMenu/)
  })

  for (const file of componentFiles) {
    const rel = relPath(file)
    it(`${rel} has no drag-only interaction, or is on the allow list`, () => {
      if (isAllowed(rel, 'drag-only')) return
      const text = readFileSync(file, 'utf8')
      const hits = findDragMarkers(text)
      expect(
        hits.map((h) => `${rel}:${h.line} ${h.match}`),
        'draggable, onDragStart, onDrag, onDrop, setPointerCapture, or ondragstart with no allow-list entry'
      ).toEqual([])
    })
  }
})

// -- rule 2: no hover-only reveal in JSX ----------------------------------------------------------

describe('no hover-only reveal in JSX (CLAUDE.md: no drag-only or hover-only interactions)', () => {
  it('positive control: findHoverHandlersJsx reports planted mouse-only handlers', () => {
    const fake = ['function Reveal() {', '  return <div onMouseEnter={show} onMouseLeave={hide}>x</div>', '}'].join('\n')
    const hits = findHoverHandlersJsx(fake)
    expect(hits.length).toBeGreaterThan(0)
    expect(hasFocusPath(fake)).toBe(false)
  })

  it('a file with the same handlers plus onFocus is not flagged', () => {
    const fake = [
      'function Reveal() {',
      '  return <div onMouseEnter={show} onMouseLeave={hide} onFocus={show}>x</div>',
      '}',
    ].join('\n')
    expect(findHoverHandlersJsx(fake).length).toBeGreaterThan(0)
    expect(hasFocusPath(fake)).toBe(true)
  })

  for (const file of componentFiles) {
    const rel = relPath(file)
    it(`${rel} reveals on hover only if it also reveals on focus, or is on the allow list`, () => {
      const text = readFileSync(file, 'utf8')
      const hits = findHoverHandlersJsx(text)
      if (hits.length === 0) return
      if (hasFocusPath(text)) return
      if (isAllowed(rel, 'hover-only-jsx')) return
      const found = hits.map((h) => `${rel}:${h.line} ${h.handler}`)
      expect(found, 'onMouseEnter/onMouseOver/onMouseLeave with no onFocus or onFocusCapture in the same file').toEqual([])
    })
  }
})

// -- rule 3: no hover-only reveal in CSS ----------------------------------------------------------

describe('no hover-only reveal in CSS (CLAUDE.md: no drag-only or hover-only interactions)', () => {
  it('positive control: findHoverOnlyCss reports a planted hover-only display rule', () => {
    const fake = '.tip:hover { display: block; }'
    const hits = findHoverOnlyCss(fake)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].selector).toBe('.tip:hover')
  })

  it('a rule with a :focus-within companion is not flagged', () => {
    const fake = '.tip:hover { opacity: 1; }\n.tip:focus-within { opacity: 1; }'
    expect(findHoverOnlyCss(fake)).toEqual([])
  })

  it('a rule with a :focus-visible companion in the same selector list is not flagged', () => {
    const fake = '.tip:hover,\n.tip:focus-visible {\n  opacity: 1;\n}'
    expect(findHoverOnlyCss(fake)).toEqual([])
  })

  it('src/index.css has no hover-only display/visibility/opacity rule without a focus companion, or is on the allow list', () => {
    if (isAllowed('src/index.css', 'hover-only-css')) return
    const text = readFileSync(join(root, 'src/index.css'), 'utf8')
    const hits = findHoverOnlyCss(text)
    const found = hits.map((h) => `src/index.css:${h.line} ${h.selector}`)
    expect(found, 'hover rules that set display, visibility, or opacity with no :focus-within or :focus-visible companion').toEqual(
      []
    )
  })
})

// -- rule 4: no emoji, no em dash or en dash ------------------------------------------------------

describe('no emoji in src/ (CLAUDE.md: no emoji anywhere)', () => {
  it('positive control: findEmoji reports a planted emoji', () => {
    const hits = findEmoji(`const label = "done ${CHECK_MARK_EMOJI}"`)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('digits, #, *, and the copyright/registered/trademark signs are not flagged', () => {
    expect(findEmoji(`v1 #1 *note ${COPYRIGHT_SIGN} 1999 ${REGISTERED_SIGN} ${TRADEMARK_SIGN}`)).toEqual([])
  })

  for (const file of allSrcFiles) {
    const rel = relPath(file)
    it(`${rel} has no emoji, or is on the allow list`, () => {
      if (isAllowed(rel, 'emoji')) return
      const text = readFileSync(file, 'utf8')
      const hits = findEmoji(text)
      expect(hits.map((h) => `${rel}:${h.line} ${h.char}`), 'emoji characters').toEqual([])
    })
  }
})

describe('no em dash or en dash (CLAUDE.md: no em dashes in docs or UI text)', () => {
  it('positive control: findDashes reports a planted em dash and en dash', () => {
    expect(findDashes(`one ${EM_DASH} two`).length).toBe(1)
    expect(findDashes(`one ${EN_DASH} two`).length).toBe(1)
  })

  const dashScanFiles = [...allSrcFiles, ...markdownFiles]

  for (const file of dashScanFiles) {
    const rel = relPath(file)
    it(`${rel} has no em dash or en dash, or is on the allow list`, () => {
      if (isAllowed(rel, 'dash')) return
      const text = readFileSync(file, 'utf8')
      const hits = findDashes(text)
      expect(hits.map((h) => `${rel}:${h.line}`), 'em dash (U+2014) or en dash (U+2013)').toEqual([])
    })
  }
})

// -- allow list cannot rot -------------------------------------------------------------------------

describe('allow list', () => {
  it('has entries to check', () => {
    expect(ALLOW_LIST.length).toBeGreaterThan(0)
  })

  it('every entry still matches a real violation', () => {
    const dashScanFiles = [...allSrcFiles, ...markdownFiles]
    const stale = ALLOW_LIST.filter((entry) => {
      if (entry.rule === 'drag-only') {
        const file = componentFiles.find((f) => relPath(f) === entry.file)
        return !file || findDragMarkers(readFileSync(file, 'utf8')).length === 0
      }
      if (entry.rule === 'hover-only-jsx') {
        const file = componentFiles.find((f) => relPath(f) === entry.file)
        if (!file) return true
        const text = readFileSync(file, 'utf8')
        return hasFocusPath(text) || findHoverHandlersJsx(text).length === 0
      }
      if (entry.rule === 'hover-only-css') {
        if (entry.file !== 'src/index.css') return true
        return findHoverOnlyCss(readFileSync(join(root, 'src/index.css'), 'utf8')).length === 0
      }
      if (entry.rule === 'emoji') {
        const file = allSrcFiles.find((f) => relPath(f) === entry.file)
        return !file || findEmoji(readFileSync(file, 'utf8')).length === 0
      }
      if (entry.rule === 'dash') {
        const file = dashScanFiles.find((f) => relPath(f) === entry.file)
        return !file || findDashes(readFileSync(file, 'utf8')).length === 0
      }
      return true
    }).map((entry) => `${entry.file} (${entry.rule})`)
    expect(stale, 'allow list entries that no longer match a real violation').toEqual([])
  })
})
