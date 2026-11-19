// Whether the on-screen keyboard is open, written to data-keyboard="open" on <html> so that
// src/index.css can hide the phone's tab bar and the New task button while the owner types
// (docs/phone-keyboard-and-system-bars.md). Neither is any use then, and on a phone they would sit
// on top of the keyboard and take a sixth of the little room left.
//
// No browser says outright that the keyboard is open. It counts as open when a text field has
// focus and the visible part of the page has dropped by at least a keyboard's height
// (KEYBOARD_MIN_PX) below what it was with no field focused. The Android app (Capacitor shortens
// the WebView by the keyboard) and a phone browser (which shrinks the visual viewport) both pass.
// Each test alone gets it wrong: focus alone would hide the bar for a hardware keyboard, or after
// the keyboard is put away with Back while the field keeps focus, and a window that is short to
// begin with (split screen, a small desktop window) never drops, so it is not mistaken for one.
// The height is taken times the pinch zoom (visualViewport.scale), so zooming in, which shrinks
// the visual viewport too, does not count.
//
// Closing waits SHOW_DELAY_MS before the bar comes back, so moving from one field to the next,
// which blurs one before it focuses the other, does not flash the bar in and out. Opening hides it
// at once.
//
// When the keyboard comes up, the box being typed in has to end up whole above it. The browser
// sees to that itself in the usual case: it brings the focused box to the middle of what is left.
// But if text arrives while the keyboard is still coming up (a hardware keyboard with the
// on-screen one showing as well, or a script), the browser only brings the caret into view, and a
// 44px box is left with its lower 13px under the keyboard. So SETTLE_MS after the visible height
// stops changing, a focused box that is cut off is scrolled just far enough to show whole
// (showFocusedBox). A box that already shows whole is never moved, so the browser's own placing
// stands, and this runs only for the keyboard coming up: a later change of height (a phone
// browser's address bar while the owner scrolls) never pulls the page back to the box.

export const SHOW_DELAY_MS = 200
// How long the visible height has to hold still after the keyboard comes up before the focused
// box is looked at. The browser's own scroll follows the resize within about 50ms.
export const SETTLE_MS = 300
// Phone keyboards are 250px and more; a browser's address bar coming and going is about 56px.
export const KEYBOARD_MIN_PX = 150
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

// The visible height in unzoomed CSS pixels, or null without visualViewport.
export function visibleHeight(win = window) {
  const vv = win.visualViewport
  if (!vv) return null
  return vv.height * (vv.scale || 1)
}

// Open when a text field has focus and the visible height is a keyboard's height under
// `baseline`, the height with no field focused.
export function keyboardLooksOpen(baseline, win = window) {
  const height = visibleHeight(win)
  if (height === null || !baseline) return false
  if (!isTextEntry(win.document.activeElement)) return false
  return baseline - height >= KEYBOARD_MIN_PX
}

// Scrolls the focused text field just far enough to show whole, if the visible part of the page
// cuts it off at the top or the bottom. Returns whether it scrolled. A field taller than what is
// visible (long notes) is left to the browser, which keeps the caret in view. jsdom has no
// scrollIntoView.
export function showFocusedBox(win = window) {
  const vv = win.visualViewport
  const el = win.document.activeElement
  if (!vv || !isTextEntry(el)) return false
  const box = el.getBoundingClientRect()
  const top = vv.offsetTop || 0
  const bottom = top + vv.height
  if (box.height > vv.height) return false
  if (box.top >= top - 0.5 && box.bottom <= bottom + 0.5) return false
  if (typeof el.scrollIntoView !== 'function') return false
  el.scrollIntoView({ block: 'nearest' })
  return true
}

// Starts watching and returns a function that stops it and clears the attribute.
export function watchKeyboard(win = window) {
  const root = win.document.documentElement
  let showTimer = null
  // Set while the keyboard that just came up settles; null once the focused box has been looked at.
  let settleTimer = null
  let baseline = visibleHeight(win)
  let width = win.innerWidth

  const setOpen = (open) => {
    if (open) root.dataset.keyboard = 'open'
    else delete root.dataset.keyboard
  }

  const settle = () => {
    win.clearTimeout(settleTimer)
    settleTimer = win.setTimeout(() => {
      settleTimer = null
      if (keyboardLooksOpen(baseline, win)) showFocusedBox(win)
    }, SETTLE_MS)
  }

  const update = (event) => {
    const height = visibleHeight(win)
    if (height === null) return
    // A keyboard that comes up in steps: each step puts the look at the focused box off again.
    if (settleTimer !== null && event?.type === 'resize') settle()
    // With no field focused and the bar showing, the keyboard is down, so this is the height to
    // measure from; it follows the address bar and split screen. While the bar is hidden, a blur
    // is usually focus moving to the next field with the keyboard still up, so the height then is
    // not one to measure from. A turn of the phone starts over.
    const marked = root.dataset.keyboard === 'open' || showTimer !== null
    if (win.innerWidth !== width || (!isTextEntry(win.document.activeElement) && !marked)) baseline = height
    else baseline = Math.max(baseline || 0, height)
    width = win.innerWidth

    if (keyboardLooksOpen(baseline, win)) {
      win.clearTimeout(showTimer)
      showTimer = null
      if (root.dataset.keyboard !== 'open') settle()
      setOpen(true)
      return
    }
    if (root.dataset.keyboard !== 'open' || showTimer !== null) return
    showTimer = win.setTimeout(() => {
      showTimer = null
      setOpen(keyboardLooksOpen(baseline, win))
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
    win.clearTimeout(settleTimer)
    setOpen(false)
  }
}
