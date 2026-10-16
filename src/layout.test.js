// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The parts of CONTRIBUTING.md's "Nothing is cut off" that can be read off the source, as unit
// tests. jsdom lays nothing out, so whether something is really cut off is measured in a browser
// by e2e/clipping.spec.js; these catch the patterns that cause it before the browser suite runs.
// Shape follows src/interactions.test.js: a positive control per rule, then the real files.

const srcDir = dirname(fileURLToPath(import.meta.url))
const root = join(srcDir, '..')
const css = readFileSync(join(srcDir, 'index.css'), 'utf8')

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (/\.jsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full)
  }
  return acc
}
const componentFiles = walk(srcDir)
const relPath = (file) => relative(root, file).split(sep).join('/')
const lineOf = (text, index) => text.slice(0, index).split('\n').length

// Every rule of a stylesheet as { selector, body, line }, media queries flattened. Comments are
// blanked first (keeping line numbers), so a commented-out declaration never counts.
export function cssRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const rules = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const selector = m[1].replace(/^[\s\S]*@media[^{]*$/, '').trim()
    if (!selector || selector.startsWith('@')) continue
    rules.push({ selector: selector.replace(/\s+/g, ' '), body: m[2], line: lineOf(clean, m.index + m[0].indexOf(m[1].trim())) })
  }
  return rules
}

const decl = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`))
  return m ? m[1].trim() : null
}

// -- rule 1: no silent clip -----------------------------------------------------------------------
// Text that may not wrap and is clipped must at least show an ellipsis; nowrap with overflow
// hidden and nothing else cuts words off with no sign that anything is missing.

export function findSilentClipCss(text) {
  return cssRules(text)
    .filter((r) => decl(r.body, 'white-space') === 'nowrap' && /^(hidden|clip)/.test(decl(r.body, 'overflow') || decl(r.body, 'overflow-x') || ''))
    .filter((r) => decl(r.body, 'text-overflow') !== 'ellipsis')
    // Visually hidden on purpose (the sr-only pattern): it is clipped away whole, not cut off.
    .filter((r) => !decl(r.body, 'clip') && !decl(r.body, 'clip-path'))
    .map((r) => ({ line: r.line, selector: r.selector }))
}

// The innermost object literal around each `whiteSpace: 'nowrap'` in JSX source.
export function findSilentClipJsx(text) {
  const hits = []
  const re = /whiteSpace:\s*['"]nowrap['"]/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let start = m.index
    for (let depth = 0; start > 0; start--) {
      if (text[start] === '}') depth++
      else if (text[start] === '{') {
        if (depth === 0) break
        depth--
      }
    }
    let end = m.index
    for (let depth = 0; end < text.length; end++) {
      if (text[end] === '{') depth++
      else if (text[end] === '}') {
        if (depth === 0) break
        depth--
      }
    }
    const object = text.slice(start, end + 1)
    if (/overflow(X)?:\s*['"](hidden|clip)['"]/.test(object) && !/textOverflow:\s*['"]ellipsis['"]/.test(object)) {
      hits.push({ line: lineOf(text, m.index) })
    }
  }
  return hits
}

describe('no silent clip: nowrap text that is clipped shows an ellipsis', () => {
  it('positive control: findSilentClipCss reports a planted rule and passes its ellipsis twin', () => {
    expect(findSilentClipCss('.a { white-space: nowrap; overflow: hidden; }')).toHaveLength(1)
    expect(findSilentClipCss('.a { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }')).toEqual([])
    expect(findSilentClipCss('.sr { white-space: nowrap; overflow: hidden; clip: rect(0 0 0 0); }')).toEqual([])
  })

  it('positive control: findSilentClipJsx reports a planted style and passes its ellipsis twin', () => {
    expect(findSilentClipJsx("<span style={{ whiteSpace: 'nowrap', overflow: 'hidden' }}>x</span>")).toHaveLength(1)
    expect(findSilentClipJsx("<span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>x</span>")).toEqual([])
    expect(findSilentClipJsx("const s = { a: { b: 1 }, whiteSpace: 'nowrap', overflow: 'hidden' }")).toHaveLength(1)
  })

  it('src/index.css clips nowrap text only behind an ellipsis', () => {
    expect(findSilentClipCss(css).map((h) => `src/index.css:${h.line} ${h.selector}`)).toEqual([])
  })

  for (const file of componentFiles) {
    const rel = relPath(file)
    it(`${rel} clips nowrap text only behind an ellipsis`, () => {
      expect(findSilentClipJsx(readFileSync(file, 'utf8')).map((h) => `${rel}:${h.line}`)).toEqual([])
    })
  }
})

// -- rule 2: the page shell never hides sideways overflow -----------------------------------------
// overflow-x: hidden on the shell turns a sideways scrollbar into content nobody can reach, and
// hides the overflow from expectNoHorizontalOverflow too.

const SHELL = /^(html|body|#root|\.app-shell|\.app-content|\.app-main[\w-]*)$/

export function findShellClip(text) {
  return cssRules(text)
    .filter((r) => r.selector.split(',').some((s) => SHELL.test(s.trim())))
    .filter((r) => /^(hidden|clip)/.test(decl(r.body, 'overflow-x') || decl(r.body, 'overflow') || ''))
    .map((r) => ({ line: r.line, selector: r.selector }))
}

describe('the page shell never hides sideways overflow', () => {
  it('positive control: findShellClip reports body { overflow-x: hidden }', () => {
    expect(findShellClip('body { overflow-x: hidden; }')).toHaveLength(1)
    expect(findShellClip('.card { overflow: hidden; }')).toEqual([])
  })

  it('src/index.css leaves html, body, and the app shell free to show sideways overflow', () => {
    expect(findShellClip(css).map((h) => `src/index.css:${h.line} ${h.selector}`)).toEqual([])
  })
})

// -- rule 3: a scroll box never centres its content -----------------------------------------------
// What overflows the start of a centred scroll box can never be scrolled to. `safe center` is fine.

export function findCentredScroller(text) {
  return cssRules(text)
    .filter((r) => /^(auto|scroll)/.test(decl(r.body, 'overflow') || decl(r.body, 'overflow-x') || decl(r.body, 'overflow-y') || ''))
    .filter((r) => ['justify-content', 'align-items', 'place-content', 'place-items'].some((p) => /^center\b/.test(decl(r.body, p) || '')))
    .map((r) => ({ line: r.line, selector: r.selector }))
}

describe('a scroll box never centres its content', () => {
  it('positive control: findCentredScroller reports a centred scroller and passes safe center', () => {
    expect(findCentredScroller('.s { overflow-x: auto; justify-content: center; }')).toHaveLength(1)
    expect(findCentredScroller('.s { overflow-x: auto; justify-content: safe center; }')).toEqual([])
  })

  it('src/index.css has no centred scroll box', () => {
    expect(findCentredScroller(css).map((h) => `src/index.css:${h.line} ${h.selector}`)).toEqual([])
  })
})

// -- rule 4: rings inside where neighbours touch --------------------------------------------------
// Rows, list items, sidebar items, and menu content touch their neighbours or a clipping edge, so
// their focus ring is drawn inside (outline-offset: -2px). e2e/clipping.spec.js measures the
// result; this keeps the selectors from being dropped from the rule.

describe('focus rings are drawn inside where neighbours touch', () => {
  const inside = cssRules(css).filter((r) => decl(r.body, 'outline-offset') === '-2px').flatMap((r) => r.selector.split(',').map((s) => s.trim()))
  for (const selector of ['.mytasks-row:focus-visible', '.mytasks-list :focus-visible', '.mytasks-colhead :focus-visible', '.nav-item:focus-visible', '[data-popover] :focus-visible']) {
    it(`${selector} draws its ring inside`, () => {
      expect(inside).toContain(selector)
    })
  }

  it('the My tasks list does not clip (it is a flat table on the page, not a card)', () => {
    const list = cssRules(css).filter((r) => r.selector.split(',').some((s) => s.trim() === '.mytasks-list'))
    expect(list.filter((r) => /^(hidden|clip)/.test(decl(r.body, 'overflow') || ''))).toEqual([])
  })

  it('the Board strip leaves room for a card ring inside its scroll box', () => {
    const lanes = cssRules(css).find((r) => r.selector === '.board-lanes')
    const padding = (decl(lanes.body, 'padding') || '0').split(/\s+/).map((v) => parseFloat(v))
    expect(Math.min(...padding)).toBeGreaterThanOrEqual(4)
  })
})

// -- rule 5: the New task button never covers the last row for good -------------------------------

const px = (value) => (value.match(/(\d+(?:\.\d+)?)px/g) || []).reduce((sum, v) => sum + parseFloat(v), 0)

describe('the floating New task button leaves room for the last row', () => {
  it('the page under the button has bottom padding past its top edge', () => {
    const rules = cssRules(css)
    const fab = rules.find((r) => r.selector === '.fab' && decl(r.body, 'position') === 'fixed')
    const room = rules.find((r) => r.selector === '.app-main-full:has(.fab)')
    expect(fab, 'the phone .fab rule').toBeTruthy()
    expect(room, 'an .app-main-full:has(.fab) rule').toBeTruthy()
    expect(px(decl(room.body, 'padding-bottom'))).toBeGreaterThan(px(decl(fab.body, 'bottom')) + px(decl(fab.body, 'height')))
  })
})

// -- rule 6: .flush-last only inside a bordered panel ---------------------------------------------
// It drops the last row's divider so it does not double the panel's edge. On a flat list there
// is no edge, and the last row's column lines would end in the air.

export function findBareFlushLast(text) {
  const hits = []
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const names = (m[1] ?? m[2] ?? m[3]).split(/\s+/)
    if (names.includes('flush-last') && !names.includes('surface')) hits.push({ line: lineOf(text, m.index) })
  }
  return hits
}

describe('.flush-last only on a bordered panel', () => {
  it('positive control: findBareFlushLast reports a bare flush-last and passes one on a surface', () => {
    expect(findBareFlushLast('<div className="flush-last">')).toHaveLength(1)
    expect(findBareFlushLast('<div className="surface flush-last list">')).toEqual([])
  })

  for (const file of componentFiles) {
    const rel = relPath(file)
    it(`${rel} uses .flush-last only with .surface`, () => {
      expect(findBareFlushLast(readFileSync(file, 'utf8')).map((h) => `${rel}:${h.line}`)).toEqual([])
    })
  }
})

// -- rule 7: long words break, and nothing scrolls into view under a sticky bar --------------------

describe('long words break and scrolled-to content clears the sticky bars', () => {
  const rules = cssRules(css)

  it('body breaks a word longer than its line', () => {
    const body = rules.find((r) => r.selector === 'body')
    expect(decl(body.body, 'overflow-wrap')).toMatch(/^(break-word|anywhere)$/)
  })

  it('the page scroll padding clears the top bar, and on a phone the tab bar', () => {
    const top = rules.filter((r) => r.selector === 'html').map((r) => decl(r.body, 'scroll-padding-top')).find(Boolean)
    const bottom = rules.filter((r) => r.selector === 'html').map((r) => decl(r.body, 'scroll-padding-bottom')).find(Boolean)
    // The top bar is 56px (the My tasks column header sticks at top: 56) and the tab bar 64px.
    expect(px(top || '')).toBeGreaterThanOrEqual(56)
    expect(px(bottom || '')).toBeGreaterThanOrEqual(64)
  })
})
