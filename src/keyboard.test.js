import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { SHOW_DELAY_MS, isTextEntry, keyboardLooksOpen, watchKeyboard } from './keyboard'

// jsdom has no visualViewport, so each test puts in one it can resize, and a 900px tall screen.
let viewport
let stop

function resizeViewport(height) {
  viewport.height = height
  viewport.dispatchEvent(new Event('resize'))
}

function field(html) {
  document.body.innerHTML = html
  return document.body.firstElementChild
}

const isOpen = () => document.documentElement.dataset.keyboard === 'open'

beforeEach(() => {
  vi.useFakeTimers()
  viewport = new EventTarget()
  viewport.height = 860
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  Object.defineProperty(window.screen, 'height', { configurable: true, value: 900 })
})

afterEach(() => {
  stop?.()
  stop = undefined
  document.body.innerHTML = ''
  vi.useRealTimers()
  delete window.visualViewport
})

describe('isTextEntry', () => {
  test('text fields, text areas, and editable regions bring up the keyboard', () => {
    expect(isTextEntry(field('<input>'))).toBe(true)
    expect(isTextEntry(field('<input type="search">'))).toBe(true)
    expect(isTextEntry(field('<textarea></textarea>'))).toBe(true)
    const editable = field('<div contenteditable="true"></div>')
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isTextEntry(editable)).toBe(true)
  })

  test('buttons, checkboxes, date pickers, and read-only or disabled fields do not', () => {
    expect(isTextEntry(field('<button>Go</button>'))).toBe(false)
    expect(isTextEntry(field('<input type="checkbox">'))).toBe(false)
    expect(isTextEntry(field('<input type="date">'))).toBe(false)
    expect(isTextEntry(field('<input readonly>'))).toBe(false)
    expect(isTextEntry(field('<input disabled>'))).toBe(false)
    expect(isTextEntry(null)).toBe(false)
  })
})

describe('keyboardLooksOpen', () => {
  test('needs both a focused text field and a viewport under three quarters of the screen', () => {
    const input = field('<input>')
    input.focus()
    expect(keyboardLooksOpen()).toBe(false)
    viewport.height = 500
    expect(keyboardLooksOpen()).toBe(true)
    input.blur()
    expect(keyboardLooksOpen()).toBe(false)
  })

  test('a short window with nothing focused, as in split screen, is not a keyboard', () => {
    field('<input>')
    viewport.height = 400
    expect(keyboardLooksOpen()).toBe(false)
  })

  test('without visualViewport it never reports open', () => {
    delete window.visualViewport
    field('<input>').focus()
    expect(keyboardLooksOpen()).toBe(false)
  })
})

describe('watchKeyboard', () => {
  test('marks the page at once when the keyboard opens, and clears it after the delay when it closes', () => {
    stop = watchKeyboard()
    const input = field('<input>')
    input.focus()
    expect(isOpen()).toBe(false)
    resizeViewport(500)
    expect(isOpen()).toBe(true)

    resizeViewport(860)
    expect(isOpen()).toBe(true)
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  test('moving from one field to the next does not bring the bar back in between', () => {
    stop = watchKeyboard()
    document.body.innerHTML = '<input id="a"><input id="b">'
    document.getElementById('a').focus()
    resizeViewport(500)
    expect(isOpen()).toBe(true)

    document.getElementById('a').blur()
    expect(isOpen()).toBe(true)
    vi.advanceTimersByTime(SHOW_DELAY_MS / 2)
    document.getElementById('b').focus()
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    expect(isOpen()).toBe(true)
  })

  test('putting the keyboard away with Back, the field still focused, brings the bar back', () => {
    stop = watchKeyboard()
    field('<input>').focus()
    resizeViewport(500)
    resizeViewport(860)
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  test('stopping clears the mark', () => {
    stop = watchKeyboard()
    field('<input>').focus()
    resizeViewport(500)
    stop()
    stop = undefined
    expect(isOpen()).toBe(false)
  })
})
