import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import RepeatBuilder, { RepeatSelect, previewText } from './RepeatBuilder'

afterEach(cleanup)

// 2026-10-14 is a Wednesday.
const DUE = '2026-10-14'

// A controlled host, as the real callers are.
function Host({ initial = 'weekly', onChange, api, Component = RepeatBuilder }) {
  const [value, setValue] = useState(initial)
  return (
    <Component
      value={value}
      dueIso={DUE}
      api={api}
      onChange={(v) => { setValue(v); onChange?.(v) }}
    />
  )
}

describe('RepeatBuilder', () => {
  test('More and Fewer step the interval', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE')
    expect(screen.getByRole('button', { name: 'Fewer' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Fewer' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;BYDAY=WE')
  })

  test('Fewer is disabled at 1', () => {
    render(<Host />)
    expect(screen.getByRole('button', { name: 'Fewer' }).disabled).toBe(true)
  })

  test('month unit shows the day of the month, and Last day gives BYMONTHDAY=-1', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat unit' }), { target: { value: 'month' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYMONTHDAY=14')
    fireEvent.change(screen.getByRole('combobox', { name: 'Day of the month' }), { target: { value: '-1' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYMONTHDAY=-1')
  })

  test('The second Tuesday gives BYDAY=2TU', () => {
    const onChange = vi.fn()
    render(<Host initial="monthly" onChange={onChange} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'On' })).getByRole('radio', { name: /The/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Which week of the month' }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Weekday' }), { target: { value: 'TU' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYDAY=2TU')
  })

  test('weekday buttons add days, and the last pressed one cannot be unpressed', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    const wed = screen.getByRole('button', { name: 'Wednesday' })
    expect(wed.getAttribute('aria-pressed')).toBe('true')
    expect(wed.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Friday' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;BYDAY=WE,FR')
    expect(screen.getByRole('button', { name: 'Wednesday' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;BYDAY=FR')
    expect(screen.getByRole('button', { name: 'Friday' }).disabled).toBe(true)
  })

  test('the last weekday of the month gives BYDAY=-1 and reads back as last', () => {
    const onChange = vi.fn()
    render(<Host initial="monthly" onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Which week of the month' }), { target: { value: '-1' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYDAY=-1WE')
    expect(screen.getByRole('combobox', { name: 'Which week of the month' }).value).toBe('-1')
  })

  test('Ends: On writes UNTIL from the date box, After writes COUNT, Never takes them off', () => {
    const onChange = vi.fn()
    render(<Host initial="daily" onChange={onChange} />)
    const ends = screen.getByRole('group', { name: 'Ends' })
    expect(within(ends).getByRole('radio', { name: 'Never' }).checked).toBe(true)

    fireEvent.click(within(ends).getByRole('radio', { name: /^On/ }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=DAILY;UNTIL=20270114')
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-12-31' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=DAILY;UNTIL=20261231')
    // A cleared box keeps the date it had.
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=DAILY;UNTIL=20261231')

    fireEvent.change(screen.getByRole('combobox', { name: 'Number of times' }), { target: { value: '5' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=DAILY;COUNT=5')
    expect(within(ends).getByRole('radio', { name: /^After/ }).checked).toBe(true)
    expect(within(ends).getByText('times')).toBeTruthy()

    fireEvent.click(within(ends).getByRole('radio', { name: 'Never' }))
    expect(onChange).toHaveBeenLastCalledWith('daily')
  })

  test('a rule that ends shows its end chosen', () => {
    render(<Host initial="FREQ=WEEKLY;BYDAY=MO;COUNT=1" />)
    const ends = screen.getByRole('group', { name: 'Ends' })
    expect(within(ends).getByRole('radio', { name: /^After/ }).checked).toBe(true)
    expect(screen.getByRole('combobox', { name: 'Number of times' }).value).toBe('1')
    expect(within(ends).getByText('time')).toBeTruthy()
  })

  test('counting from the finish hides the day choices and writes X-FROM; the due date brings them back', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    const from = screen.getByRole('group', { name: 'Next one counts from' })
    expect(within(from).getByRole('radio', { name: 'The due date' }).checked).toBe(true)

    fireEvent.click(within(from).getByRole('radio', { name: 'The day I finish it' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;X-FROM=COMPLETION')
    expect(screen.queryByRole('button', { name: 'Wednesday' })).toBeNull()
    expect(screen.getByText('Each one is due a week after the day you finish the one before.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;INTERVAL=2;X-FROM=COMPLETION')
    expect(screen.getByText('Each one is due 2 weeks after the day you finish the one before.')).toBeTruthy()

    fireEvent.click(within(from).getByRole('radio', { name: 'The due date' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE')
    expect(screen.getByRole('button', { name: 'Wednesday' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('a finish-anchored rule with an end round trips through the builder', () => {
    const onChange = vi.fn()
    render(<Host initial="FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION" onChange={onChange} />)
    expect(screen.getByRole('radio', { name: 'The day I finish it' }).checked).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Number of times' }), { target: { value: '4' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=DAILY;INTERVAL=3;COUNT=4;X-FROM=COMPLETION')
  })

  test('shows the next dates from the server', async () => {
    const api = { previewRecurrence: vi.fn().mockResolvedValue({ dates: ['2026-10-24', '2026-10-31'] }) }
    render(<Host api={api} />)
    expect(await screen.findByText('Next: Sat, Oct 24; Sat, Oct 31')).toBeTruthy()
    expect(api.previewRecurrence).toHaveBeenCalledWith('weekly', DUE, 3)
  })

  test('an empty list says it is the last one', async () => {
    const api = { previewRecurrence: vi.fn().mockResolvedValue({ dates: [] }) }
    render(<Host api={api} />)
    expect(await screen.findByText('No later dates: this is the last one.')).toBeTruthy()
  })

  test('shows nothing when the preview fails', async () => {
    const api = { previewRecurrence: vi.fn().mockRejectedValue(new Error('offline')) }
    render(<Host api={api} />)
    await waitFor(() => expect(api.previewRecurrence).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('previewText', () => {
  test('null, empty, and dates', () => {
    expect(previewText(null)).toBeNull()
    expect(previewText([])).toBe('No later dates: this is the last one.')
    expect(previewText(['2026-10-24'])).toBe('Next: Sat, Oct 24')
  })

  test('a rule counted from the finish says the dates assume it is done on the day', () => {
    expect(previewText(['2026-10-24'], true)).toBe('If each is finished on its due date, next: Sat, Oct 24')
    expect(previewText([], true)).toBe('No later dates: this is the last one.')
  })
})

describe('RepeatSelect', () => {
  test('Custom shows the builder and a preset hides it', () => {
    const onChange = vi.fn()
    render(<Host initial="" Component={RepeatSelect} onChange={onChange} />)
    expect(screen.queryByRole('group', { name: 'Every' })).toBeNull()
    const select = screen.getAllByRole('combobox')[0]
    fireEvent.change(select, { target: { value: 'custom' } })
    expect(screen.getByRole('group', { name: 'Every' })).toBeTruthy()
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'daily' } })
    expect(onChange).toHaveBeenLastCalledWith('daily')
    expect(screen.queryByRole('group', { name: 'Every' })).toBeNull()
  })

  test('a rule that is not a preset opens the builder', () => {
    render(<Host initial="every 3 days" Component={RepeatSelect} />)
    expect(screen.getByRole('group', { name: 'Every' })).toBeTruthy()
  })

  test('offers the quick picks worded from the due date, then Custom', () => {
    render(<Host initial="" Component={RepeatSelect} />)
    const options = within(screen.getAllByRole('combobox')[0]).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual([
      'Does not repeat', 'Daily', 'Every weekday (Monday to Friday)', 'Weekends', 'Weekly on Wednesday',
      'Every 2 weeks on Wednesday', 'Monthly on day 14', 'Monthly on the second Wednesday', 'Every 3 months on day 14',
      'Annually on October 14', 'Custom',
    ])
  })

  test('a quick pick writes its rule in full and stays selected, with no builder', () => {
    const onChange = vi.fn()
    render(<Host initial="" Component={RepeatSelect} onChange={onChange} />)
    const select = screen.getAllByRole('combobox')[0]
    fireEvent.change(select, { target: { value: 'FREQ=MONTHLY;BYDAY=2WE' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYDAY=2WE')
    expect(select.selectedOptions[0].textContent).toBe('Monthly on the second Wednesday')
    expect(screen.queryByRole('group', { name: 'Every' })).toBeNull()
  })

  test('an alias shows as the quick pick it means', () => {
    render(<Host initial="weekly" Component={RepeatSelect} />)
    expect(screen.getAllByRole('combobox')[0].selectedOptions[0].textContent).toBe('Weekly on Wednesday')
    expect(screen.queryByRole('group', { name: 'Every' })).toBeNull()
  })

  test('a rule with an end shows as Custom with the builder', () => {
    render(<Host initial="FREQ=DAILY;COUNT=3" Component={RepeatSelect} />)
    expect(screen.getAllByRole('combobox')[0].value).toBe('custom')
    expect(screen.getByRole('radio', { name: /^After/ }).checked).toBe(true)
  })
})
