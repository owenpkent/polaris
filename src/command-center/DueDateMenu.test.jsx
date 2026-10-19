import { describe, test, expect, vi, afterEach } from 'vitest'
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import DueDateMenu from './DueDateMenu'
import { getDueBounds } from './dueDates'

afterEach(() => cleanup())

const DUE_BOUNDS = getDueBounds(new Date('2026-10-08T12:00:00'))

// A trigger with the menu open under it, the way TaskRow and the task panel use it.
function Harness({ value, onChange, repeat }) {
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
        {...repeat}
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

// Repeats under the month, wired as TaskRow and the task panel wire it.
function renderRepeat(value = '2026-10-08', recurrence = null, dates = ['2026-10-15', '2026-10-22', '2026-10-29']) {
  const onChange = vi.fn()
  const onRecurrenceChange = vi.fn()
  const api = { previewRecurrence: vi.fn().mockResolvedValue({ dates }) }
  render(<Harness value={value} onChange={onChange} repeat={{ recurrence, onRecurrenceChange, api }} />)
  return { onChange, onRecurrenceChange, api, picker: () => screen.queryByRole('dialog', { name: 'Due date' }) }
}

describe('Repeats', () => {
  test('is left out when the caller does not set the repeat', () => {
    renderMenu()
    expect(screen.queryByLabelText('Repeats')).toBeNull()
  })

  test('a choice saves the rule at once and keeps the picker open', () => {
    const { onRecurrenceChange, onChange, picker } = renderRepeat()
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
    const select = screen.getByLabelText('Repeats')
    expect(select.value).toBe('none')
    fireEvent.change(select, { target: { value: 'weekly' } })
    expect(onRecurrenceChange).toHaveBeenCalledWith('FREQ=WEEKLY;BYDAY=TH')
    expect(onChange).not.toHaveBeenCalled()
    expect(picker()).not.toBeNull()
    // The weekly choice shows its weekdays, the due date's own pressed.
    expect(screen.getByRole('button', { name: 'Thursday' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('the next dates of the repeat are tinted on the month', async () => {
    const { api } = renderRepeat('2026-10-08', 'FREQ=WEEKLY;BYDAY=TH')
    await waitFor(() => expect(api.previewRecurrence).toHaveBeenCalledWith('FREQ=WEEKLY;BYDAY=TH', '2026-10-08', 3))
    const next = await screen.findByRole('button', { name: 'Thursday, October 15, 2026, repeats' })
    expect(next.hasAttribute('data-repeat')).toBe(true)
    expect(day('Friday, October 16, 2026').hasAttribute('data-repeat')).toBe(false)
  })

  test('Does not repeat saves null', () => {
    const { onRecurrenceChange } = renderRepeat('2026-10-08', 'daily')
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'none' } })
    expect(onRecurrenceChange).toHaveBeenCalledWith(null)
  })

  test('on a task with no date, a repeat sets the date to today with it', () => {
    const { onRecurrenceChange } = renderRepeat(null)
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'daily' } })
    expect(onRecurrenceChange).toHaveBeenCalledWith('daily', DUE_BOUNDS.today)
    expect(day('Thursday, October 8, 2026').getAttribute('aria-pressed')).toBe('true')
  })

  test('a time typed first goes with the date a repeat sets', () => {
    const { onRecurrenceChange } = renderRepeat(null)
    fireEvent.click(screen.getByRole('button', { name: 'Add time' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '07:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'daily' } })
    expect(onRecurrenceChange).toHaveBeenCalledWith('daily', `${DUE_BOUNDS.today}T07:30`)
  })

  test('a plain repeat follows a newly picked day, saved with it', () => {
    const { onChange, picker } = renderRepeat('2026-10-08', 'FREQ=WEEKLY;BYDAY=TH')
    fireEvent.click(day('Friday, October 9, 2026'))
    expect(onChange).toHaveBeenCalledWith('2026-10-09', 'FREQ=WEEKLY;BYDAY=FR')
    expect(picker()).toBeNull()
  })

  test('a repeat that does not name the day is saved with the day alone', () => {
    const { onChange } = renderRepeat('2026-10-08', 'daily')
    fireEvent.click(day('Friday, October 9, 2026'))
    expect(onChange).toHaveBeenCalledWith('2026-10-09')
    cleanup()
    // The bare alias follows the due date on its own, so it is not spelled out.
    const second = renderRepeat('2026-10-08', 'weekly')
    fireEvent.click(day('Friday, October 9, 2026'))
    expect(second.onChange).toHaveBeenCalledWith('2026-10-09')
  })

  test('a repeat just chosen follows the day picked after it', () => {
    const { onChange, onRecurrenceChange } = renderRepeat()
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'weekly' } })
    expect(onRecurrenceChange).toHaveBeenCalledWith('FREQ=WEEKLY;BYDAY=TH')
    fireEvent.click(day('Monday, October 12, 2026'))
    expect(onChange).toHaveBeenCalledWith('2026-10-12', 'FREQ=WEEKLY;BYDAY=MO')
  })

  test('Custom opens the builder in the picker, and a rule made there keeps its days on a new day', () => {
    const { onChange, onRecurrenceChange } = renderRepeat('2026-10-08', 'FREQ=WEEKLY;BYDAY=TH')
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'custom' } })
    expect(screen.getByRole('group', { name: 'Ends' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(onRecurrenceChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;INTERVAL=2;BYDAY=TH')
    fireEvent.click(day('Friday, October 9, 2026'))
    expect(onChange).toHaveBeenCalledWith('2026-10-09')
  })

  test('a rule the builder cannot show is named and left to the task panel', () => {
    const { onChange } = renderRepeat('2026-10-08', 'FREQ=YEARLY;BYMONTH=1,7')
    expect(screen.queryByLabelText('Repeats')).toBeNull()
    expect(screen.getByText(/Change it under More details in the task panel\.$/)).toBeTruthy()
    fireEvent.click(day('Friday, October 9, 2026'))
    expect(onChange).toHaveBeenCalledWith('2026-10-09')
  })
})

describe('the Repeat toggle', () => {
  test('is off by default: only the Repeat button, nothing tinted, nothing asked of the server', () => {
    const { api } = renderRepeat()
    expect(screen.getByRole('button', { name: 'Repeat' })).toBeTruthy()
    expect(screen.queryByLabelText('Repeats')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove repeat' })).toBeNull()
    expect(document.querySelector('[data-repeat]')).toBeNull()
    expect(api.previewRecurrence).not.toHaveBeenCalled()
  })

  test('turning it on shows Repeats on Does not repeat, focused, and saves nothing', async () => {
    const { onRecurrenceChange, onChange } = renderRepeat()
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
    const select = screen.getByLabelText('Repeats')
    expect(select.value).toBe('none')
    await waitFor(() => expect(document.activeElement).toBe(select))
    expect(screen.queryByRole('button', { name: 'Repeat' })).toBeNull()
    expect(onRecurrenceChange).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  test('a task that repeats opens with it on', () => {
    renderRepeat('2026-10-08', 'daily')
    expect(screen.getByLabelText('Repeats').value).toBe('daily')
    expect(screen.getByRole('button', { name: 'Remove repeat' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Repeat' })).toBeNull()
  })

  test('Remove repeat saves no repeat, hides Repeats and the tint, and puts focus back on Repeat', async () => {
    const { onRecurrenceChange, picker } = renderRepeat('2026-10-08', 'FREQ=WEEKLY;BYDAY=TH')
    await screen.findByRole('button', { name: 'Thursday, October 15, 2026, repeats' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove repeat' }))
    expect(onRecurrenceChange).toHaveBeenCalledWith(null)
    expect(picker()).not.toBeNull()
    expect(screen.queryByLabelText('Repeats')).toBeNull()
    expect(document.querySelector('[data-repeat]')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Repeat' })))
  })

  test('Remove repeat before a choice is made saves nothing', () => {
    const { onRecurrenceChange } = renderRepeat()
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove repeat' }))
    expect(onRecurrenceChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Repeat' })).toBeTruthy()
  })

  test('a rule the builder cannot show has no Remove repeat, so it is not lost by accident', () => {
    renderRepeat('2026-10-08', 'FREQ=YEARLY;BYMONTH=1,7')
    expect(screen.queryByRole('button', { name: 'Remove repeat' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Repeat' })).toBeNull()
  })
})
