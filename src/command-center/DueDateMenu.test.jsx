import { describe, test, expect, vi, afterEach } from 'vitest'
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import DueDateMenu from './DueDateMenu'
import { getDueBounds } from './dueDates'

afterEach(() => cleanup())

const DUE_BOUNDS = getDueBounds(new Date('2026-10-08T12:00:00'))

// A trigger with the menu open under it, the way TaskRow and the task panel use it.
function Harness({ value, onChange }) {
  const btnRef = useRef(null)
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" ref={btnRef} onClick={() => setOpen(true)}>Due</button>
      <DueDateMenu
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        value={value}
        dueBounds={DUE_BOUNDS}
        onChange={onChange}
        label="Due date"
      />
    </>
  )
}

function renderMenu(value = '2026-10-08') {
  const onChange = vi.fn()
  render(<Harness value={value} onChange={onChange} />)
  return { onChange, input: screen.getByLabelText('Date'), menu: () => screen.queryByRole('menu', { name: 'Due date' }) }
}

describe('the date box edits a draft', () => {
  test('a segment edit saves nothing and keeps the menu open', () => {
    const { onChange, input, menu } = renderMenu()
    // Chromium fires change with the year 0002 after the first digit of 2027 is typed.
    fireEvent.change(input, { target: { value: '0002-10-08' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
    expect(input.value).toBe('0002-10-08')
  })

  test('Enter in the date box saves the draft and closes the menu', () => {
    const { onChange, input, menu } = renderMenu()
    fireEvent.change(input, { target: { value: '2027-10-08' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('2027-10-08')
    expect(menu()).toBeNull()
  })

  test('Set date saves the draft, and is disabled until the date differs from the task', () => {
    const { onChange, input } = renderMenu()
    const set = screen.getByRole('menuitem', { name: 'Set date' })
    expect(set.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '2027-10-08' } })
    expect(set.disabled).toBe(false)
    fireEvent.click(set)
    expect(onChange).toHaveBeenCalledWith('2027-10-08')
  })

  test('an empty date box has nothing to save', () => {
    const { onChange, input, menu } = renderMenu()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Set date' }).disabled).toBe(true)
  })

  test('Up and Down stay in the date box instead of moving between items', () => {
    const { input } = renderMenu()
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(input)
  })

  test('reopening the menu drops an unsaved draft', () => {
    const { onChange, input } = renderMenu()
    fireEvent.change(input, { target: { value: '2027-10-08' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Due' }))
    expect(screen.getByLabelText('Date').value).toBe('2026-10-08')
  })
})

describe('the quick picks', () => {
  test('save and close at once', () => {
    const { onChange, menu } = renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tomorrow' }))
    expect(onChange).toHaveBeenCalledWith(DUE_BOUNDS.tomorrow)
    expect(menu()).toBeNull()
  })

  test('Clear saves null', () => {
    const { onChange } = renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
