// Whether the on-screen keyboard is open, written to data-keyboard="open" on <html> so that
// src/index.css can hide the phone's tab bar and the New task button while the owner types
// (docs/phone-keyboard-and-system-bars.md). Neither is any use then, and on a phone they would sit
// on top of the keyboard and take a sixth of the little room left.
//
// No browser says outright that the keyboard is open. It counts as open when a text field has
// focus and the visible part of the page is under three quarters of the screen's height: a
// focused field alone would also hide the bar for a hardware keyboard, or after the keyboard is
// put away with Back while the field keeps focus, and a short viewport alone would hide it in a
// split-screen window. The Android app (Capacitor shrinks the WebView by the keyboard) and a
// phone browser (which shrinks the visual viewport) both pass the test.
//
// Closing waits SHOW_DELAY_MS before the bar comes back, so moving from one field to the next,
// which blurs one before it focuses the other, does not flash the bar in and out. Opening hides it
// at once.

export const SHOW_DELAY_MS = 200
const SHORT_FRACTION = 0.75
// Input types that type text, and so bring up the keyboard. A date or a checkbox opens a picker or
// nothing at all.
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])

export function isTextEntry(el) {
  if (!el || el.disabled || el.readOnly) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false
  return TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase())
}

export function keyboardLooksOpen(win = window) {
  const vv = win.visualViewport
  const screenHeight = win.screen?.height
  if (!vv || !screenHeight) return false
  if (!isTextEntry(win.document.activeElement)) return false
  return vv.height < screenHeight * SHORT_FRACTION
}

// Starts watching and returns a function that stops it and clears the attribute.
export function watchKeyboard(win = window) {
  const root = win.document.documentElement
  let showTimer = null

  const setOpen = (open) => {
    if (open) root.dataset.keyboard = 'open'
    else delete root.dataset.keyboard
  }

  const update = () => {
    if (keyboardLooksOpen(win)) {
      win.clearTimeout(showTimer)
      showTimer = null
      setOpen(true)
      return
    }
    if (root.dataset.keyboard !== 'open' || showTimer !== null) return
    showTimer = win.setTimeout(() => {
      showTimer = null
      setOpen(keyboardLooksOpen(win))
    }, SHOW_DELAY_MS)
  }

  const vv = win.visualViewport
  vv?.addEventListener('resize', update)
  win.addEventListener('resize', update)
  win.document.addEventListener('focusin', update)
  win.document.addEventListener('focusout', update)
  update()

  return () => {
    vv?.removeEventListener('resize', update)
    win.removeEventListener('resize', update)
    win.document.removeEventListener('focusin', update)
    win.document.removeEventListener('focusout', update)
    win.clearTimeout(showTimer)
    setOpen(false)
  }
}
