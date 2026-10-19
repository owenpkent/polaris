import { describe, test, expect, vi, afterEach } from 'vitest'
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  return { onChange, picker: () => screen.queryByRole('dialog', { name: 'Due date' }) }
}

const day = (name) => screen.getByRole('button', { name })

describe('it opens straight onto the month', () => {
  test('a labelled dialog with the quick dates and the month, and no date box or Set date', () => {
    const { picker } = renderMenu()
    const dialog = picker()
    expect(dialog).not.toBeNull()
    expect(within(dialog).queryByRole('menu')).toBeNull()
    expect(within(dialog).queryAllByRole('menuitem')).toEqual([])
    const quick = within(dialog).getByRole('group', { name: 'Quick dates' })
    expect(within(quick).getAllByRole('button').map((b) => b.textContent)).toEqual(['Today', 'Tomorrow', 'Next Monday', 'No date'])
    expect(within(dialog).getByRole('grid', { name: 'Due date, October 2026' })).toBeTruthy()
    expect(screen.queryByLabelText('Date')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Set date/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'In one week' })).toBeNull()
  })

  test('the task day is shown pressed and takes focus when the menu opens', async () => {
    renderMenu('2026-11-20')
    const target = day('Friday, November 20, 2026')
    expect(target.getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(target))
  })

  test('with no due date it opens on today, with No date pressed', async () => {
    renderMenu(null)
    expect(screen.getByRole('button', { name: 'No date' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(day('Thursday, October 8, 2026')))
  })

  test('Escape closes it and puts focus back on the trigger', async () => {
    const { onChange, picker } = renderMenu()
    await waitFor(() => expect(picker().contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(picker()).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Due' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('one pick saves and closes', () => {
  test('a day of the month', () => {
    const { onChange, picker } = renderMenu()
    fireEvent.click(day('Monday, October 12, 2026'))
    expect(onChange).toHaveBeenCalledWith('2026-10-12')
    expect(picker()).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Due' }))
  })

  test('Enter on a day reached with the arrow keys', async () => {
    const { onChange } = renderMenu()
    const start = day('Thursday, October 8, 2026')
    await waitFor(() => expect(document.activeElement).toBe(start))
    fireEvent.keyDown(start, { key: 'ArrowRight' })
    const next = day('Friday, October 9, 2026')
    expect(document.activeElement).toBe(next)
    // A button's Enter is a click.
    fireEvent.click(next)
    expect(onChange).toHaveBeenCalledWith('2026-10-09')
  })

  test('a quick date', () => {
    const { onChange, picker } = renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    expect(onChange).toHaveBeenCalledWith(DUE_BOUNDS.tomorrow)
    expect(picker()).toBeNull()
  })

  test('No date saves null', () => {
    const { onChange, picker } = renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'No date' }))
    expect(onChange).toHaveBeenCalledWith(null)
    expect(picker()).toBeNull()
  })

  test('picking the day the task already has closes without saving', () => {
    const { onChange, picker } = renderMenu('2026-10-08')
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(picker()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('the time', () => {
  test('Add time opens an empty time box and focuses it', async () => {
    renderMenu('2026-10-08')
    expect(screen.queryByLabelText('Time')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    const time = screen.getByLabelText('Time')
    expect(time.value).toBe('')
    await waitFor(() => expect(document.activeElement).toBe(time))
  })

  test('Enter in the time box saves the day and the time as floating local time', () => {
    const { onChange, picker } = renderMenu('2026-10-08')
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    const time = screen.getByLabelText('Time')
    fireEvent.change(time, { target: { value: '09:30' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('2026-10-08T09:30')
    expect(picker()).toBeNull()
  })

  test('a time with no date yet goes on today', () => {
    const { onChange } = renderMenu(null)
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    const time = screen.getByLabelText('Time')
    fireEvent.change(time, { target: { value: '08:00' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(`${DUE_BOUNDS.today}T08:00`)
  })

  test('a time just typed goes with the day picked next, and with a quick date', () => {
    const { onChange } = renderMenu('2026-10-20')
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:15' } })
    fireEvent.click(day('Thursday, October 22, 2026'))
    expect(onChange).toHaveBeenLastCalledWith('2026-10-22T08:15')
    cleanup()
    const second = renderMenu('2026-10-20')
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    expect(second.onChange).toHaveBeenCalledWith(`${DUE_BOUNDS.tomorrow}T08:15`)
  })

  test('a task with a time opens with the box filled, and a new day keeps the time', () => {
    const { onChange } = renderMenu('2026-10-08T09:30')
    expect(screen.getByLabelText('Time').value).toBe('09:30')
    fireEvent.click(day('Monday, October 12, 2026'))
    expect(onChange).toHaveBeenCalledWith('2026-10-12T09:30')
  })

  test('a quick date keeps the task time', () => {
    const { onChange } = renderMenu('2026-10-08T09:30')
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    expect(onChange).toHaveBeenCalledWith(`${DUE_BOUNDS.tomorrow}T09:30`)
  })

  test('Enter in the box saves a changed time', () => {
    const { onChange } = renderMenu('2026-10-08T09:30')
    const time = screen.getByLabelText('Time')
    fireEvent.change(time, { target: { value: '16:45' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('2026-10-08T16:45')
  })

  test('emptying the time box and pressing Enter keeps the day alone', () => {
    const { onChange } = renderMenu('2026-10-08T09:30')
    const time = screen.getByLabelText('Time')
    fireEvent.change(time, { target: { value: '' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('2026-10-08')
  })

  test('Remove time on a task with a time saves the day without it', () => {
    const { onChange, picker } = renderMenu('2026-10-08T09:30')
    fireEvent.click(screen.getByRole('button', { name: 'Remove time' }))
    expect(onChange).toHaveBeenCalledWith('2026-10-08')
    expect(picker()).toBeNull()
  })

  test('Remove time on a box just opened closes it and puts focus back on Add time', async () => {
    const { onChange, picker } = renderMenu('2026-10-08')
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove time' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(picker()).not.toBeNull()
    expect(screen.queryByLabelText('Time')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add time' })))
    fireEvent.click(day('Friday, October 9, 2026'))
    expect(onChange).toHaveBeenCalledWith('2026-10-09')
  })

  test('reopening the menu drops a time typed and not saved', () => {
    const { onChange } = renderMenu('2026-10-08')
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:00' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Due' }))
    expect(screen.queryByLabelText('Time')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add time' })).toBeTruthy()
  })

  // Chromium reports '' for a time box with a segment cleared (validity.badInput), the same as an
  // empty one. A half-typed time must not read as "no time".
  test('a half-typed time is not a cleared time: Enter saves nothing and a new day keeps the old time', () => {
    const { onChange, picker } = renderMenu('2026-10-20T09:30')
    const time = screen.getByLabelText('Time')
    Object.defineProperty(time, 'validity', { configurable: true, value: { badInput: true, valid: false } })
    fireEvent.change(time, { target: { value: '' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(picker()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    expect(onChange).toHaveBeenCalledWith(`${DUE_BOUNDS.tomorrow}T09:30`)
  })

  test('a zoned due value opens on its local day and time, and saves the local floating form', () => {
    const zoned = new Date(2026, 9, 20, 21, 45).toISOString()
    const { onChange } = renderMenu(zoned)
    expect(day('Tuesday, October 20, 2026').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Time').value).toBe('21:45')
    fireEvent.click(day('Thursday, October 22, 2026'))
    expect(onChange).toHaveBeenCalledWith('2026-10-22T21:45')
  })
})
