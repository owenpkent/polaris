import { useRef } from 'react'

// Tracks an IME composition on a text field, so the Enter or Escape that confirms or cancels a
// candidate in a Chinese, Japanese, or Korean input method is not taken as the field's own. Browsers
// mark that key differently: Chrome fires it with isComposing, Safari after compositionend with
// keyCode 229, and some fire it before compositionend with neither, which the flag covers.
// `props` go on the input; `isComposing(e)` is asked first in its keydown handler.
export function useComposition() {
  const composing = useRef(false)
  return {
    isComposing: (e) => composing.current || Boolean(e.nativeEvent?.isComposing) || e.keyCode === 229,
    props: {
      onCompositionStart: () => { composing.current = true },
      onCompositionEnd: () => { composing.current = false },
    },
  }
}
