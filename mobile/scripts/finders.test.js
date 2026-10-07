import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Runs the FINDERS script that WebAppDriver.java injects into the app's WebView, read straight from
// the Java source so the test cannot drift from what the device runs.
const source = readFileSync(
  join(process.cwd(), 'mobile/android/app/src/androidTest/java/com/okstudio/polaris/WebAppDriver.java'),
  'utf8',
)
const start = source.indexOf('FINDERS =')
const block = source.slice(start, source.indexOf(';\n', start))
const literals = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
const script = literals.join('').replace(/\\(["\\])/g, '$1')

function load(html) {
  document.body.innerHTML = html
  document.querySelectorAll('*').forEach((el) => {
    el.getClientRects = () => [{}]
  })
  delete window.__pt
  window.eval(script)
  return window.__pt
}

afterEach(() => {
  document.body.innerHTML = ''
  delete window.__pt
})

describe('WebAppDriver FINDERS', () => {
  it('finds the drawer Connection item that also shows its status', () => {
    const pt = load('<button class="a"><span>Connection</span><span><i></i>Connected</span></button>')
    expect(pt.find('button', 'Connection')).toBe(document.querySelector('.a'))
  })

  it('prefers the exact match over a substring match', () => {
    const pt = load('<button id="x">Connection settings</button><button id="y">Connection</button>')
    expect(pt.find('button', 'Connection').id).toBe('y')
  })

  it('falls back to a case-insensitive substring', () => {
    const pt = load('<button id="x">Save Connection now</button>')
    expect(pt.find('button', 'save connection').id).toBe('x')
  })

  it('uses aria-label over text and ignores aria-hidden children', () => {
    const pt = load(
      '<button id="a" aria-label="Inbox, 2 waiting">Inbox<span>2</span></button>' +
        '<button id="b">Tasks<span aria-hidden="true">9</span></button>',
    )
    expect(pt.find('button', 'Inbox, 2 waiting').id).toBe('a')
    expect(pt.find('button', 'Tasks').id).toBe('b')
  })

  it('searches only under a root when one is given', () => {
    // The not-connected banner's Connect comes before the form's Connect in the page.
    const pt = load('<button id="banner">Connect</button><form id="f"><button id="submit">Connect</button></form>')
    expect(pt.find('button', 'Connect').id).toBe('banner')
    expect(pt.find('button', 'Connect', document.getElementById('f')).id).toBe('submit')
  })

  it('returns null when nothing matches', () => {
    const pt = load('<button>Other</button>')
    expect(pt.find('button', 'Connection')).toBeNull()
  })
})
