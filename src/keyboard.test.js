import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { KEYBOARD_MIN_PX, SETTLE_MS, SHOW_DELAY_MS, isTextEntry, keyboardLooksOpen, showFocusedBox, visibleHeight, watchKeyboard } from './keyboard'

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

const rectAt = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 200, width: 200 })

// A field at a place on the page (jsdom lays nothing out), with a spy for the scroll jsdom lacks.
function placedField({ top, height = 44, html = '<input>' }) {
  const el = field(html)
  el.getBoundingClientRect = () => rectAt(top, height)
  el.scrollIntoView = vi.fn()
  return el
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

  test('once the keyboard has come up and settled, a focused box left cut off is shown whole', () => {
    stop = watchKeyboard()
    const input = placedField({ top: 286 })
    input.focus()
    resizeViewport(317)
    expect(isOpen()).toBe(true)
    // Not at once: the browser's own scroll comes just after the resize and is given its turn.
    expect(input.scrollIntoView).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SETTLE_MS - 1)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(input.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  test('a box the browser placed whole is left where it is', () => {
    stop = watchKeyboard()
    const input = placedField({ top: 200 })
    input.focus()
    resizeViewport(317)
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
  })

  test('a keyboard that comes up in steps is waited out', () => {
    stop = watchKeyboard()
    const input = placedField({ top: 286 })
    input.focus()
    resizeViewport(600)
    expect(isOpen()).toBe(true)
    vi.advanceTimersByTime(SETTLE_MS - 50)
    resizeViewport(317)
    vi.advanceTimersByTime(SETTLE_MS - 50)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(input.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  test('a later change of height with the keyboard up does not pull the page back to the box', () => {
    stop = watchKeyboard()
    const input = placedField({ top: 200 })
    input.focus()
    resizeViewport(317)
    vi.advanceTimersByTime(SETTLE_MS)
    // The owner scrolls the box out of sight, and a phone browser's address bar comes back.
    input.getBoundingClientRect = () => rectAt(500, 44)
    resizeViewport(261)
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(isOpen()).toBe(true)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
  })

  test('nothing is scrolled when the keyboard went away again before it settled', () => {
    stop = watchKeyboard()
    const input = placedField({ top: 286 })
    input.focus()
    resizeViewport(317)
    resizeViewport(860)
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(isOpen()).toBe(false)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
  })

  test('nor when focus has left the field for a button by then', () => {
    stop = watchKeyboard()
    document.body.innerHTML = '<input><button>Done</button>'
    const input = document.querySelector('input')
    input.getBoundingClientRect = () => rectAt(286, 44)
    input.scrollIntoView = vi.fn()
    const button = document.querySelector('button')
    button.scrollIntoView = vi.fn()
    input.focus()
    resizeViewport(317)
    button.focus()
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
    expect(button.scrollIntoView).not.toHaveBeenCalled()
  })

  test('stopping drops the look that was still to come', () => {
    stop = watchKeyboard()
    const input = placedField({ top: 286 })
    input.focus()
    resizeViewport(317)
    stop()
    stop = undefined
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
  })
})

describe('showFocusedBox', () => {
  beforeEach(() => { viewport.height = 317 })

  test('a focused box cut off at the bottom of what is visible is scrolled just into view', () => {
    const input = placedField({ top: 286 })
    input.focus()
    expect(showFocusedBox()).toBe(true)
    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  test('so is one cut off at the top', () => {
    const input = placedField({ top: -10 })
    input.focus()
    expect(showFocusedBox()).toBe(true)
  })

  test('a box that shows whole is not moved, one that touches the edge included', () => {
    const middle = placedField({ top: 200 })
    middle.focus()
    expect(showFocusedBox()).toBe(false)
    expect(middle.scrollIntoView).not.toHaveBeenCalled()

    const edge = placedField({ top: 273 })
    edge.focus()
    expect(showFocusedBox()).toBe(false)
    expect(edge.scrollIntoView).not.toHaveBeenCalled()
  })

  test('what is visible starts where the visual viewport does', () => {
    viewport.offsetTop = 100
    const under = placedField({ top: 380 })
    under.focus()
    expect(showFocusedBox()).toBe(true)

    const inside = placedField({ top: 360 })
    inside.focus()
    expect(showFocusedBox()).toBe(false)

    const above = placedField({ top: 90 })
    above.focus()
    expect(showFocusedBox()).toBe(true)
  })

  test('a field taller than what is visible is left to the browser, which keeps the caret in view', () => {
    const notes = placedField({ top: 100, height: 400, html: '<textarea></textarea>' })
    notes.focus()
    expect(showFocusedBox()).toBe(false)
    expect(notes.scrollIntoView).not.toHaveBeenCalled()
  })

  test('nothing happens with no field focused, a button focused, or no visual viewport', () => {
    expect(showFocusedBox()).toBe(false)

    const button = placedField({ top: 286, html: '<button>Go</button>' })
    button.focus()
    expect(showFocusedBox()).toBe(false)
    expect(button.scrollIntoView).not.toHaveBeenCalled()

    const input = placedField({ top: 286 })
    input.focus()
    delete window.visualViewport
    expect(showFocusedBox()).toBe(false)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
  })
})
