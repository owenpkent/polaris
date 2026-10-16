import { useLayoutEffect } from 'react'

// Keeps a one-line-of-meaning textarea (a task title) as tall as its text, so a long title wraps
// and is read in full instead of being cut at the box's edge (CONTRIBUTING.md, "Nothing is cut
// off"). Measures again when the text changes and when the box's width does. The textarea sets
// rows={1}, resize: none, overflow: hidden, and flex-shrink: 0 (in a flex column an overflow: hidden
// box may otherwise be shrunk to nothing); Enter is the caller's to handle.
export function useFitToText(ref, text) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const fit = () => {
      // Not laid out yet (a panel still opening): leave the one-row height, and measure again
      // when the observer below sees the box get its width.
      if (!el.clientWidth) {
        el.style.height = ''
        return
      }
      el.style.height = 'auto'
      // scrollHeight leaves out the borders, which border-box sizing counts in the height.
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return undefined
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fit()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, text])
}

// A line break typed or pasted into a title becomes a space: a title is one line of meaning.
export const oneLine = (value) => value.replace(/\r?\n/g, ' ')
