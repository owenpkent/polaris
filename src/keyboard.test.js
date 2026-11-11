import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { KEYBOARD_MIN_PX, SHOW_DELAY_MS, isTextEntry, keyboardLooksOpen, visibleHeight, watchKeyboard } from './keyboard'

// jsdom has no visualViewport, so each test puts in one it can resize and zoom.
let viewport
let stop

function resizeViewport(height, scale = 1) {
  viewport.height = height
  viewport.scale = scale
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
  viewport.scale = 1
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
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
  test('needs both a focused text field and a drop of a keyboard height from the baseline', () => {
    const input = field('<input>')
    input.focus()
    expect(keyboardLooksOpen(860)).toBe(false)
    viewport.height = 860 - KEYBOARD_MIN_PX + 1
    expect(keyboardLooksOpen(860)).toBe(false)
    viewport.height = 500
    expect(keyboardLooksOpen(860)).toBe(true)
    input.blur()
    expect(keyboardLooksOpen(860)).toBe(false)
  })

  test('pinch zoom is taken out of the height', () => {
    viewport.height = 430
    viewport.scale = 2
    expect(visibleHeight()).toBe(860)
    field('<input>').focus()
    expect(keyboardLooksOpen(860)).toBe(false)
  })

  test('without visualViewport it never reports open', () => {
    delete window.visualViewport
    field('<input>').focus()
    expect(visibleHeight()).toBe(null)
    expect(keyboardLooksOpen(860)).toBe(false)
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

  test('a window that is short to begin with is not a keyboard when a field is focused', () => {
    resizeViewport(400)
    stop = watchKeyboard()
    field('<input>').focus()
    resizeViewport(400)
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  test('a window made short before a field is focused is not a keyboard either', () => {
    stop = watchKeyboard()
    resizeViewport(400)
    field('<input>').focus()
    vi.advanceTimersByTime(SHOW_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  test('zooming in with a field focused is not a keyboard', () => {
    stop = watchKeyboard()
    field('<input>').focus()
    resizeViewport(430, 2)
    resizeViewport(215, 4)
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

  test('the keyboard is still caught after the address bar has come and gone', () => {
    stop = watchKeyboard()
    resizeViewport(804)
    resizeViewport(860)
    const input = field('<input>')
    input.focus()
    resizeViewport(520)
    expect(isOpen()).toBe(true)
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
