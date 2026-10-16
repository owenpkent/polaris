import { describe, test, expect, afterEach } from 'vitest'
import { useRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { oneLine, useFitToText } from './useFitToText'

afterEach(() => {
  cleanup()
})

function Box({ text }) {
  const ref = useRef(null)
  useFitToText(ref, text)
  return <textarea ref={ref} aria-label="Box" rows={1} value={text} readOnly />
}

describe('useFitToText', () => {
  // jsdom lays nothing out, so every box has no width: the state of a panel that is still opening.
  // Setting a height then would fix the box at 0px and hide it, which is the bug this guards.
  test('leaves a box that is not laid out at its one-row height', () => {
    const { getByLabelText } = render(<Box text="A long title" />)
    expect(getByLabelText('Box').style.height).toBe('')
  })

  test('a typed or pasted line break becomes a space', () => {
    expect(oneLine('First line\nsecond\r\nthird')).toBe('First line second third')
  })
})
