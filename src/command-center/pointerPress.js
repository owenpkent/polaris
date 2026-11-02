import { useEffect, useRef } from 'react'

// The pointer, for a box that adds or closes when it is left: the list's Add task row
// (InlineTaskInput.jsx), a board lane's Add task (BoardTab.jsx), and the task panel's Add subtask
// (TaskDetailPanel.jsx). `held` is true from a press to its release, so a box that changes size
// can wait for the release: changing on the press would move what is under the pointer, and the
// release would land on something else. `clicking` stays true past the release until the click
// the press makes, since a mouse moves focus on the press and a touch on the tap after the
// release. A blur while it is true was a click elsewhere, not Tab, Esc, or a script moving focus.
export function usePointerPress(active = true) {
  const press = useRef({ held: false, clicking: false })
  useEffect(() => {
    if (!active) return undefined
    const p = press.current
    let timer = null
    const down = () => {
      clearTimeout(timer)
      p.held = true
      p.clicking = true
    }
    // A press that makes no click (dragged off what it pressed) stops counting soon after.
    const up = () => {
      p.held = false
      clearTimeout(timer)
      timer = setTimeout(() => { p.clicking = false }, 500)
    }
    const end = () => {
      clearTimeout(timer)
      p.held = false
      p.clicking = false
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', end, true)
    window.addEventListener('click', end, true)
    return () => {
      end()
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', end, true)
      window.removeEventListener('click', end, true)
    }
  }, [active])
  return press
}

// Calls fn once the pointer held now is released or cancelled, with that event. On a release it
// runs before the click the release makes.
export function afterRelease(fn) {
  const done = (e) => {
    window.removeEventListener('pointerup', done, true)
    window.removeEventListener('pointercancel', done, true)
    fn(e)
  }
  window.addEventListener('pointerup', done, true)
  window.addEventListener('pointercancel', done, true)
}
