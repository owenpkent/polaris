import { describe, test, expect, afterEach } from 'vitest'
import { useRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { oneLine, useFitToText } from './useFitToText'

// jsdom lays nothing out: every box has no width, no height, and no scroll height. A test that
// needs a laid-out box gives the textarea prototype the measurements of one, and takes them back.
const laidOut = { clientWidth: 200, scrollHeight: 115 }
const descriptors = {}
function layOut() {
  for (const [key, value] of Object.entries(laidOut)) {
    descriptors[key] = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, key)
    Object.defineProperty(HTMLTextAreaElement.prototype, key, { configurable: true, get: () => value })
  }
}

afterEach(() => {
  cleanup()
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(HTMLTextAreaElement.prototype, key, descriptor)
    else delete HTMLTextAreaElement.prototype[key]
    delete descriptors[key]
  }
})

function Box({ text, loading = false, focusRef = null }) {
  const attach = useFitToText(text, focusRef)
  if (loading) return <p>Loading</p>
  return <textarea ref={attach} aria-label="Box" rows={1} value={text} readOnly />
}

describe('useFitToText', () => {
  // The state of a panel that is still opening. Setting a height then would fix the box at 0px
  // and hide it, which is the bug this guards.
  test('leaves a box that is not laid out at its one-row height', () => {
    const { getByLabelText } = render(<Box text="A long title" />)
    expect(getByLabelText('Box').style.height).toBe('')
  })

  test('makes a laid-out box as tall as its text', () => {
    layOut()
    const { getByLabelText } = render(<Box text="A long title" />)
    expect(getByLabelText('Box').style.height).toBe('115px')
  })

  // A panel that switches task shows Loading, which unmounts its fields, then mounts new ones.
  // When the next task has the same title or assignee, the text is unchanged, so only a fit that
  // follows the box itself measures the new one; a fit keyed on a ref object left it at one row.
  test('fits the new box after the field is unmounted and mounted again with the same text', () => {
    layOut()
    const { getByLabelText, rerender } = render(<Box text="A long title" />)
    const first = getByLabelText('Box')
    expect(first.style.height).toBe('115px')
    rerender(<Box text="A long title" loading />)
    rerender(<Box text="A long title" />)
    const second = getByLabelText('Box')
    expect(second).not.toBe(first)
    expect(second.style.height).toBe('115px')
  })

  test("points the caller's ref at the box, for focusing it", () => {
    let seen = null
    function Holder() {
      const ref = useRef(null)
      seen = ref
      return <Box text="A title" focusRef={ref} />
    }
    const { getByLabelText } = render(<Holder />)
    expect(seen.current).toBe(getByLabelText('Box'))
  })

  test('a typed or pasted line break becomes a space', () => {
    expect(oneLine('First line\nsecond\r\nthird')).toBe('First line second third')
  })
})
