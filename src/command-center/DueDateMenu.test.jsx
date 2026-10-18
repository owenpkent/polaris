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

describe('the time box', () => {
  test('setting a time saves the day and the time as floating local time', () => {
    const { onChange, menu } = renderMenu('2026-10-08')
    const time = screen.getByLabelText('Time')
    expect(time.value).toBe('')
    fireEvent.change(time, { target: { value: '09:30' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set date and time' }))
    expect(onChange).toHaveBeenCalledWith('2026-10-08T09:30')
    expect(menu()).toBeNull()
  })

  test('opens on the task time, and Enter in the time box saves a changed one', () => {
    const { onChange } = renderMenu('2026-10-08T09:30')
    const time = screen.getByLabelText('Time')
    expect(time.value).toBe('09:30')
    expect(screen.getByLabelText('Date').value).toBe('2026-10-08')
    expect(screen.getByRole('menuitem', { name: 'Set date and time' }).disabled).toBe(true)
    fireEvent.change(time, { target: { value: '16:45' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('2026-10-08T16:45')
  })

  test('a time with no date yet goes on today', () => {
    const { onChange } = renderMenu(null)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:00' } })
    expect(screen.getByLabelText('Date').value).toBe(DUE_BOUNDS.today)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set date and time' }))
    expect(onChange).toHaveBeenCalledWith(`${DUE_BOUNDS.today}T08:00`)
  })

  test('changing the date keeps the time', () => {
    const { onChange, input } = renderMenu('2026-10-08T09:30')
    fireEvent.change(input, { target: { value: '2026-10-12' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('2026-10-12T09:30')
  })

  test('emptying the time box and saving keeps the day alone', () => {
    const { onChange } = renderMenu('2026-10-08T09:30')
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set date' }))
    expect(onChange).toHaveBeenCalledWith('2026-10-08')
  })

  test('Remove time keeps the day, and shows only when there is a time', () => {
    renderMenu('2026-10-08')
    expect(screen.queryByRole('menuitem', { name: 'Remove time' })).toBeNull()
    cleanup()
    const { onChange } = renderMenu('2026-10-08T09:30')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove time' }))
    expect(onChange).toHaveBeenCalledWith('2026-10-08')
  })

  test('a quick pick changes the day and keeps the time', () => {
    const { onChange } = renderMenu('2026-10-08T09:30')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tomorrow' }))
    expect(onChange).toHaveBeenCalledWith(`${DUE_BOUNDS.tomorrow}T09:30`)
  })

  test('a time typed in the box goes with a quick pick', () => {
    const { onChange } = renderMenu('2026-10-20')
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:15' } })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tomorrow' }))
    expect(onChange).toHaveBeenCalledWith(`${DUE_BOUNDS.tomorrow}T08:15`)
  })

  // Chromium reports '' for a time box with a segment cleared (validity.badInput), the same as an
  // empty one. A half-typed time must not read as "no time".
  test('a half-typed time is not a cleared time: nothing saves and the old time stays', () => {
    const { onChange, input } = renderMenu('2026-10-20T09:30')
    const time = screen.getByLabelText('Time')
    Object.defineProperty(time, 'validity', { configurable: true, value: { badInput: true, valid: false } })
    fireEvent.change(time, { target: { value: '' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: /^Set date/ }).disabled).toBe(true)
    // A new day still keeps the time the task had.
    fireEvent.change(input, { target: { value: '2026-10-21' } })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tomorrow' }))
    expect(onChange).toHaveBeenCalledWith(`${DUE_BOUNDS.tomorrow}T09:30`)
  })

  test('a zoned due value opens on its local day and time, and saves the local floating form', () => {
    const zoned = new Date(2026, 9, 20, 21, 45).toISOString()
    const { onChange, input } = renderMenu(zoned)
    expect(input.value).toBe('2026-10-20')
    expect(screen.getByLabelText('Time').value).toBe('21:45')
    fireEvent.change(input, { target: { value: '2026-10-22' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('2026-10-22T21:45')
  })

  test('Up and Down stay in the time box', () => {
    renderMenu('2026-10-08T09:30')
    const time = screen.getByLabelText('Time')
    time.focus()
    fireEvent.keyDown(time, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(time)
  })
})
